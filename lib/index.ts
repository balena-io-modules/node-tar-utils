/**
 * @license
 * Copyright 2019 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as path from 'path';
import { Stream, type Readable, type Writable } from 'stream';
import * as tar from 'tar-stream';

function noop() {
	// noop
}

/**
 * normalizeTarEntry: Depending on how the tar archive was created,
 * filenames can be presented in several different forms, and this function
 * aims to make them all similar, for example;
 *  * ./Dockerfile -> Dockerfile
 *  * /Dockerfile -> Dockerfile
 *  * Dockerfile -> Dockerfile
 *  * ./a/b/Dockerfile -> a/b/Dockerfile
 *  * foo/bar/ -> foo/bar
 *  * foo/bar -> foo/bar
 * See additional input/output examples in tests.ts
 * @param name A POSIX file or directory path (i.e. using '/' as path separator)
 */
export function normalizeTarEntry(name: string): string {
	if (!name) {
		return '';
	}
	// Use the posix.normalize function under a non-POSIX platform/OS like
	// Windows, because a tar file/stream always uses '/' as path separator
	// (regardless of platform/OS) as per spec:
	// https://www.gnu.org/software/tar/manual/html_node/Standard.html
	// Also remove leading/trailing slashes and return '.' in place of an
	// empty string (provided the input was not an empty string).
	return path.posix.normalize(name).replace(/^\/+|\/+$/g, '') || '.';
}

/**
 * streamToBuffer: Given a stream, read it into a buffer
 * @param stream
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
	let onData: ((data: Buffer) => void) | undefined;
	let onError: ((error: Error) => void) | undefined;
	let onEnd: (() => void) | undefined;
	try {
		const buffers = await new Promise<Buffer[]>((resolve, reject) => {
			const chunks: Buffer[] = [];
			stream.on(
				'end',
				(onEnd = () => {
					resolve(chunks);
				}),
			);
			stream.on('error', (onError = reject));
			// adding a 'data' listener switches the stream to flowing mode
			stream.on('data', (onData = (data: Buffer) => chunks.push(data)));
		});
		return Buffer.concat(buffers);
	} finally {
		stream.removeListener('data', onData ?? noop);
		stream.removeListener('error', onError ?? noop);
		stream.removeListener('end', onEnd ?? noop);
	}
}

/**
 * Switch the given stream to flowing mode by calling its resume() method,
 * and return a promise that resolves when the stream is drained (when
 * its 'end' event is emitted). The stream contents are discarded unless
 * a 'data' handler has been previously added.
 * @param stream A readable stream to be drained
 * @return A promise that resolves when the stream is drained
 */
export async function drainStream(stream: Readable): Promise<void> {
	let onError: ((error: Error) => void) | undefined;
	let onEnd: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			stream.on('error', (onError = reject));
			stream.on('end', (onEnd = resolve));
			stream.resume();
		});
	} finally {
		stream.removeListener('error', onError ?? noop);
		stream.removeListener('end', onEnd ?? noop);
	}
}

/**
 * Create and return a promise that resolves to the pipeTo argument when the
 * pipeFrom.pipe(pipeTo) operation completes.
 * Warning: the destination stream (pipeTo) must be able to consume all the
 * source data without stream backpressure blocking, or the returned promise
 * will never resolve.
 *
 * @param pipeFrom Stream to pipe from
 * @param pipeTo Stream to pipe to
 */
export async function pipePromise<WritableSub extends Writable>(
	pipeFrom: Readable,
	pipeTo: WritableSub,
): Promise<WritableSub> {
	await Stream.promises.pipeline(pipeFrom, pipeTo);
	return pipeTo;
}

/**
 * Return a promise that resolves to a new tar.Pack stream that duplicates the
 * contents of the given sourceTarStream. The promise resolves when the source
 * stream is fully consumed. This is useful to trigger stream events on
 * listeners attached in advance by the caller to sourceTarStream, which may
 * itself be a tar.Pack stream (though any Readable will do). The new Pack
 * stream is fully cached in memory, so watch out for memory usage.
 * @param sourceTarStream Source tar stream, possibly a tar.Pack object
 * @param opts.onEntry Optional callback called for every entry in the tar
 *     stream. onEntry may return a promise which will then be awaited for.
 * @param opts.onFinish Callback called right before pack.finalize(), allowing
 *     the caller to insert additional tar entries. onFinish may return a
 *     promise which will then be awaited for.
 */
export async function cloneTarStream(
	sourceTarStream: Readable,
	opts?: {
		onEntry?: (
			pack: tar.Pack,
			header: tar.Headers,
			stream: Readable,
		) => void | Promise<void>;
		onFinish?: (pack: tar.Pack) => void | Promise<void>;
	},
): Promise<tar.Pack> {
	const [extract, pack] = throughTarStream(
		async ($pack, header, stream, callback) => {
			if (opts?.onEntry) {
				try {
					await opts.onEntry($pack, header, stream);
					callback();
				} catch (err) {
					callback(err);
				}
			} else {
				stream.pipe($pack.entry(header, callback));
			}
		},
	);
	const origPush = pack.push;
	pack.push = function (...args) {
		origPush.apply(this, args);
		// Disable backpressure as we want to buffer everything in memory in order to
		// ensure we trigger any listeners/etc that may be on the stream
		return true;
	};
	let packOnError: ((error: Error) => void) | undefined;
	let sourceTarStreamOnError: ((error: Error) => void) | undefined;
	try {
		return await new Promise<tar.Pack>((resolve, reject) => {
			packOnError = reject;
			sourceTarStreamOnError = reject;
			sourceTarStream.on('error', sourceTarStreamOnError);
			pack.on('error', packOnError);
			extract.on('error', reject);
			extract.once('finish', async () => {
				try {
					if (opts?.onFinish) {
						await opts.onFinish(pack);
					}
					resolve(pack);
				} catch (err) {
					reject(err as Error);
				}
			});
			sourceTarStream.pipe(extract);
		});
	} finally {
		sourceTarStream.removeListener('error', sourceTarStreamOnError ?? noop);
		pack.removeListener('error', packOnError ?? noop);
	}
}

/**
 * Passes an input tar stream through to an output tar stream, calling the onEntry
 * callback for every entry in the tar stream. This is done in a streaming fashion
 * so `onEntry` will not be called until the output stream is being consumed. This
 * however means that the memory will not automatically be buffered
 * @param onEntry Callback called for every entry in the tar
 * @returns A tuple of [extract, pack] streams. The extract stream should have the source
 *     tar stream piped to it, and the pack stream is the output tar stream that
 *     should be consumed by the caller. The pack stream will be finalized when the extract
 *     stream ends.
 */
export function throughTarStream(
	onEntry: (
		pack: tar.Pack,
		header: tar.Headers,
		stream: Readable,
		next: tar.Callback,
	) => void | Promise<void>,
) {
	const extract = tar.extract();
	const pack = tar.pack();
	extract
		.on('entry', async (header, stream, next) => {
			try {
				await onEntry(pack, header, stream, next);
			} catch (err) {
				next(err);
			}
		})
		.on('error', (err) => {
			pack.destroy(err);
		})
		.on('finish', () => {
			pack.finalize();
		});
	return [extract, pack] as const;
}

/**
 * "Multicast" fromStream to every toStream in the toStreams array.
 * That is, run fromStream.pipe(toStream) for every destination stream.
 * This has been tested to work also with disparate destination streams
 * that consume data at different rates (Node's pipe implementation
 * effectivelly paces reading with the slowest destination stream).
 * Return a promise that resolves when the operation "fully completes",
 * i.e. when the 'finish' event has been emitted for every stream in the
 * toStreams array.
 * @param fromStream
 * @param toStreams
 */
export async function multicastStream(
	fromStream: Readable,
	toStreams: Writable[],
): Promise<void> {
	if (toStreams.length === 0) {
		return;
	}
	let onError: ((error: Error) => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			// Note: the 'finish' listener must be added before fromStream.pipe(toStream)
			// is executed so the addition must be in a synchronous path
			Promise.all(
				toStreams.map(async (toStream: Writable) => {
					let onFinish: (() => void) | undefined;
					try {
						await new Promise<void>((toStreamResolve) =>
							toStream.on('finish', (onFinish = toStreamResolve)),
						);
						return;
					} finally {
						toStream.removeListener('finish', onFinish ?? noop);
					}
				}),
			)
				.then(() => {
					resolve();
				})
				.catch(reject);

			fromStream.on('error', (onError = reject));
			for (const toStream of toStreams) {
				toStream.on('error', onError);
				fromStream.pipe(toStream);
			}
		});
	} finally {
		fromStream.removeListener('error', onError ?? noop);
		toStreams.forEach((toStream) =>
			toStream.removeListener('error', onError ?? noop),
		);
	}
}
