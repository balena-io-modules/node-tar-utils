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
import * as Bluebird from 'bluebird';
import * as path from 'path';
import { Readable, Writable } from 'stream';
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
export function streamToBuffer(stream: Readable): Bluebird<Buffer> {
	let onData: (data: Buffer) => void;
	let onError: (error: Error) => void;
	let onEnd: () => void;
	return new Bluebird<Buffer[]>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('end', (onEnd = () => resolve(chunks)));
		stream.on('error', (onError = reject));
		// adding a 'data' listener switches the stream to flowing mode
		stream.on('data', (onData = (data: Buffer) => chunks.push(data)));
	})
		.then(Buffer.concat)
		.finally(() => {
			stream.removeListener('data', onData || noop);
			stream.removeListener('error', onError || noop);
			stream.removeListener('end', onEnd || noop);
		});
}

/**
 * Switch the given stream to flowing mode by calling its resume() method,
 * and return a promise that resolves when the stream is drained (when
 * its 'end' event is emitted). The stream contents are discarded unless
 * a 'data' handler has been previously added.
 * @param stream A readable stream to be drained
 * @return A promise that resolves when the stream is drained
 */
export function drainStream(stream: Readable): Bluebird<void> {
	let onError: (error: Error) => void;
	let onEnd: () => void;
	return new Bluebird<void>((resolve, reject) => {
		stream.on('error', (onError = reject));
		stream.on('end', (onEnd = resolve));
		stream.resume();
	}).finally(() => {
		stream.removeListener('error', onError || noop);
		stream.removeListener('end', onEnd || noop);
	});
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
export function pipePromise<WritableSub extends Writable>(
	pipeFrom: Readable,
	pipeTo: WritableSub,
): Bluebird<WritableSub> {
	let onError: (error: Error) => void;
	let onFinish: () => void;
	return new Bluebird<WritableSub>((resolve, reject) => {
		pipeFrom.on('error', (onError = reject));
		pipeTo.on('error', onError);
		pipeTo.on('finish', (onFinish = () => resolve(pipeTo)));
		pipeFrom.pipe(pipeTo);
	}).finally(() => {
		pipeFrom.removeListener('error', onError || noop);
		pipeTo.removeListener('error', onError || noop);
		pipeTo.removeListener('finish', onFinish || noop);
	});
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
export function cloneTarStream(
	sourceTarStream: Readable,
	opts?: {
		onEntry?: (pack: tar.Pack, header: tar.Headers, stream: Readable) => void;
		onFinish?: (pack: tar.Pack) => void;
	},
): Bluebird<tar.Pack> {
	const extract = tar.extract();
	const pack = tar.pack();
	const origPush = pack.push;
	pack.push = function() {
		origPush.apply(this, arguments);
		// Disable backpressure as we want to buffer everything in memory in order to
		// ensure we trigger any listeners/etc that may be on the stream
		return true;
	};
	let packOnError: (error: Error) => void;
	let sourceTarStreamOnError: (error: Error) => void;
	return new Bluebird<tar.Pack>((resolve, reject) => {
		packOnError = reject;
		sourceTarStreamOnError = reject;
		sourceTarStream.on('error', sourceTarStreamOnError);
		pack.on('error', packOnError);
		extract.on('error', reject);
		extract.on(
			'entry',
			(header: tar.Headers, stream: Readable, callback: tar.Callback) => {
				if (opts && opts.onEntry) {
					Bluebird.try(() => opts.onEntry!(pack, header, stream)).then(
						callback as () => void,
						callback,
					);
				} else {
					streamToBuffer(stream).then(buf => {
						pack.entry(header, buf, callback);
					});
				}
			},
		);
		extract.once('finish', () => {
			Bluebird.try(() => {
				if (opts && opts.onFinish) {
					return opts.onFinish(pack);
				}
			})
				.then(() => {
					pack.finalize();
					resolve(pack);
				})
				.catch(reject);
		});
		sourceTarStream.pipe(extract);
	}).finally(() => {
		sourceTarStream.removeListener('error', sourceTarStreamOnError || noop);
		pack.removeListener('error', packOnError || noop);
	});
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
export function multicastStream(
	fromStream: Readable,
	toStreams: Writable[],
): Bluebird<void> {
	if (toStreams.length === 0) {
		return Bluebird.resolve();
	}
	let onError: (error: Error) => void;
	return new Bluebird<void>((resolve, reject) => {
		// Note: there is a reason to use Bluebird.all instead of Bluebird.map
		// here. Bluebird.map defers execution of the mapper function to a
		// subsequent iteration of Node's event loop, which creates the
		// possibility that fromStream.pipe(toStream) is executed before
		// the 'finish' listener is added. By using toStreams.map(), it is
		// guaranteed that the 'finish' listener is added first.
		Bluebird.all(
			toStreams.map((toStream: Writable) => {
				let onFinish: () => void;
				return new Bluebird(toStreamResolve =>
					toStream.on('finish', (onFinish = toStreamResolve)),
				).finally(() => toStream.removeListener('finish', onFinish || noop));
			}),
		)
			.then(() => resolve())
			.catch(reject);

		fromStream.on('error', (onError = reject));
		for (const toStream of toStreams) {
			toStream.on('error', onError);
			fromStream.pipe(toStream);
		}
	}).finally(() => {
		fromStream.removeListener('error', onError || noop);
		toStreams.forEach(toStream =>
			toStream.removeListener('error', onError || noop),
		);
	});
}
