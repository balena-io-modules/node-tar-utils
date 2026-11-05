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
import { expect } from 'chai';
import { once } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import * as streamx from 'streamx';
import * as tar from 'tar-stream';

import * as TarUtils from '../lib';

const ENTRY_SIZE = 100000;

/**
 * Build the bytes of a tar archive containing a single entry of ENTRY_SIZE bytes
 */
async function buildArchive(): Promise<Buffer> {
	const pack = tar.pack();
	pack.entry({ name: 'big', size: ENTRY_SIZE }, Buffer.alloc(ENTRY_SIZE, 'a'));
	pack.finalize();
	const chunks: Buffer[] = [];
	for await (const chunk of pack) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/**
 * Feed the given bytes to a tar extract, call `onEntry` for the first entry
 * and resolve to whatever it returns. The extract is destroyed by `onEntry`
 * (or not) and is always destroyed before returning.
 */
async function withEntry<T>(
	bytes: Buffer,
	onEntry: (stream: Readable, extract: tar.Extract) => Promise<T>,
): Promise<T> {
	const extract = tar.extract();
	try {
		return await new Promise<T>((resolve, reject) => {
			extract.on('error', reject);
			extract.on('entry', (_header, stream, next) => {
				// tar-stream entries are streamx streams, which the utils accept as Readable
				const entry = stream as unknown as Readable;
				onEntry(entry, extract).then(resolve, reject);
				// Only needed on the normal path, where the entry has been consumed
				entry.once('end', () => {
					next();
				});
			});
			extract.write(bytes);
		});
	} finally {
		extract.destroy();
	}
}

async function capture(promise: Promise<unknown>): Promise<Error | undefined> {
	try {
		await promise;
	} catch (err) {
		return err as Error;
	}
	return undefined;
}

describe('premature close', function () {
	this.timeout(2000);

	describe('streamToBuffer', () => {
		it('should reject if a node stream is destroyed without an error', async () => {
			const stream = new PassThrough();
			const promise = TarUtils.streamToBuffer(stream);
			stream.write('partial');
			stream.destroy();
			const err = await capture(promise);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should still reject with the stream error if a node stream errors', async () => {
			const stream = new PassThrough();
			const promise = TarUtils.streamToBuffer(stream);
			const expected = new Error('boom');
			stream.destroy(expected);
			expect(await capture(promise)).to.equal(expected);
		});

		it('should reject if a tar entry stream is closed by destroying the extract', async () => {
			const archive = await buildArchive();
			// header + only part of the body
			const err = await withEntry(
				archive.subarray(0, 1024),
				async (stream, extract) => {
					const promise = TarUtils.streamToBuffer(stream);
					extract.destroy();
					return await capture(promise);
				},
			);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should read a complete tar entry stream', async () => {
			const archive = await buildArchive();
			const buf = await withEntry(archive, (stream) =>
				TarUtils.streamToBuffer(stream),
			);
			expect(buf.equals(Buffer.alloc(ENTRY_SIZE, 'a'))).to.equal(true);
		});
	});

	describe('drainStream', () => {
		it('should reject if a node stream is destroyed without an error', async () => {
			const stream = new PassThrough();
			const promise = TarUtils.drainStream(stream);
			stream.destroy();
			const err = await capture(promise);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should still reject with the stream error if a node stream errors', async () => {
			const stream = new PassThrough();
			const promise = TarUtils.drainStream(stream);
			const expected = new Error('boom');
			stream.destroy(expected);
			expect(await capture(promise)).to.equal(expected);
		});

		it('should resolve when a node stream ends', async () => {
			const stream = new PassThrough();
			const promise = TarUtils.drainStream(stream);
			stream.end('data');
			expect(await capture(promise)).to.equal(undefined);
		});

		it('should reject if a tar entry stream is closed by destroying the extract', async () => {
			const archive = await buildArchive();
			const err = await withEntry(
				archive.subarray(0, 1024),
				async (stream, extract) => {
					const promise = TarUtils.drainStream(stream);
					extract.destroy();
					return await capture(promise);
				},
			);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should drain a complete tar entry stream', async () => {
			const archive = await buildArchive();
			const err = await withEntry(archive, (stream) =>
				capture(TarUtils.drainStream(stream)),
			);
			expect(err).to.equal(undefined);
		});
	});

	describe('multicastStream', () => {
		it('should resolve when all destinations finish', async () => {
			const from = new PassThrough();
			const to = [new PassThrough(), new PassThrough()];
			to.forEach((d) => d.resume());
			const promise = TarUtils.multicastStream(from, to);
			from.end('data');
			expect(await capture(promise)).to.equal(undefined);
		});

		it('should reject if a destination is destroyed without an error', async () => {
			const from = new PassThrough();
			const to = [new PassThrough(), new PassThrough()];
			to.forEach((d) => d.resume());
			const promise = TarUtils.multicastStream(from, to);
			to[1].destroy();
			const err = await capture(promise);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should reject if the source is destroyed without an error', async () => {
			const from = new PassThrough();
			const to = [new PassThrough(), new PassThrough()];
			to.forEach((d) => d.resume());
			const promise = TarUtils.multicastStream(from, to);
			from.write('partial');
			from.destroy();
			const err = await capture(promise);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should still reject with the error if a destination errors', async () => {
			const from = new PassThrough();
			const to = [new PassThrough(), new PassThrough()];
			to.forEach((d) => d.resume());
			const promise = TarUtils.multicastStream(from, to);
			const expected = new Error('boom');
			to[0].destroy(expected);
			expect(await capture(promise)).to.equal(expected);
		});

		it('should reject if the destination is a tar extract destroyed without an error', async () => {
			const from = new PassThrough();
			const extract = tar.extract();
			const promise = TarUtils.multicastStream(from, [
				extract as unknown as PassThrough,
			]);
			extract.destroy();
			const err = await capture(promise);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});
	});

	describe('streams whose close is delayed or never comes', () => {
		/** A readable of 'abc' whose `_destroy` waits `ms`, or never calls back */
		function readable(ms?: number) {
			return new Readable({
				read() {
					this.push('abc');
					this.push(null);
				},
				destroy(err, callback) {
					if (ms != null) {
						setTimeout(() => {
							callback(err);
						}, ms);
					}
				},
			});
		}

		it('should resolve streamToBuffer on end without waiting for a slow close', async () => {
			const stream = readable(200);
			let closed = false;
			stream.on('close', () => {
				closed = true;
			});
			const buf = await TarUtils.streamToBuffer(stream);
			expect(buf.toString()).to.equal('abc');
			expect(stream.destroyed).to.equal(true);
			expect(closed).to.equal(false);
		});

		it('should resolve streamToBuffer on end if close never comes', async () => {
			const buf = await TarUtils.streamToBuffer(readable());
			expect(buf.toString()).to.equal('abc');
		});

		it('should resolve drainStream on end if close never comes', async () => {
			expect(await capture(TarUtils.drainStream(readable()))).to.equal(
				undefined,
			);
		});

		it('should resolve multicastStream on finish if a destination never closes', async () => {
			const from = new PassThrough();
			const to = new Writable({
				write(_chunk, _encoding, callback) {
					callback();
				},
				destroy() {
					// never calls back
				},
			});
			const promise = TarUtils.multicastStream(from, [to]);
			from.end('data');
			expect(await capture(promise)).to.equal(undefined);
		});

		it('should resolve for a node stream that has already ended', async () => {
			const stream = readable();
			stream.resume();
			await once(stream, 'end');
			expect((await TarUtils.streamToBuffer(stream)).length).to.equal(0);
			expect(await capture(TarUtils.drainStream(stream))).to.equal(undefined);
		});

		it('should resolve for a tar entry stream that has already ended', async () => {
			const archive = await buildArchive();
			const result = await withEntry(archive, async (stream) => {
				await TarUtils.drainStream(stream);
				return [
					(await TarUtils.streamToBuffer(stream)).length,
					await capture(TarUtils.drainStream(stream)),
				];
			});
			expect(result).to.deep.equal([0, undefined]);
		});

		it('should reject for a node stream already destroyed whose close never comes', async () => {
			const stream = readable();
			stream.destroy();
			const err = await capture(TarUtils.streamToBuffer(stream));
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should reject with the error for a node stream already destroyed with one whose close never comes', async () => {
			const stream = readable();
			const expected = new Error('boom');
			// 'error' is only emitted once _destroy calls back, so never here
			stream.destroy(expected);
			expect(await capture(TarUtils.drainStream(stream))).to.equal(expected);
		});
	});

	describe('streamx streams that are already done', () => {
		/** A streamx readable that has been destroyed, and has closed */
		async function destroyedStreamx(err?: Error) {
			const stream = new streamx.Readable();
			stream.on('error', () => {
				// handled by checking the rejection
			});
			const closed = new Promise<void>((resolve) => {
				stream.once('close', () => {
					resolve();
				});
			});
			stream.destroy(err);
			// not once(stream, 'close'), which rejects on 'error'
			await closed;
			return stream as unknown as Readable;
		}

		it('should reject with the error for a stream destroyed with one', async () => {
			const expected = new Error('boom');
			const stream = await destroyedStreamx(expected);
			expect(await capture(TarUtils.streamToBuffer(stream))).to.equal(expected);
			expect(await capture(TarUtils.drainStream(stream))).to.equal(expected);
		});

		it('should reject for a stream destroyed without an error', async () => {
			const stream = await destroyedStreamx();
			for (const promise of [
				TarUtils.streamToBuffer(stream),
				TarUtils.drainStream(stream),
			]) {
				const err = await capture(promise);
				expect(err).to.be.instanceOf(Error);
				expect(err!.message).to.match(/premature close/i);
			}
		});

		it('should reject for a tar entry whose extract was destroyed before the call', async () => {
			const archive = await buildArchive();
			const err = await withEntry(
				archive.subarray(0, 1024),
				async (stream, extract) => {
					extract.destroy();
					await once(extract, 'close');
					return await capture(TarUtils.streamToBuffer(stream));
				},
			);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should reject multicastStream from a destroyed source', async () => {
			const to = new PassThrough();
			to.resume();
			const err = await capture(
				TarUtils.multicastStream(await destroyedStreamx(), [to]),
			);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should reject multicastStream to a destroyed destination', async () => {
			const extract = tar.extract();
			extract.destroy();
			await once(extract, 'close');
			const err = await capture(
				TarUtils.multicastStream(new PassThrough(), [
					extract as unknown as Writable,
				]),
			);
			expect(err).to.be.instanceOf(Error);
			expect(err!.message).to.match(/premature close/i);
		});

		it('should end the destinations of multicastStream from a source that has already ended', async () => {
			const from = new streamx.Readable();
			from.push('abc');
			from.push(null);
			await TarUtils.drainStream(from as unknown as Readable);
			const to = new PassThrough();
			to.resume();
			expect(
				await capture(
					TarUtils.multicastStream(from as unknown as Readable, [to]),
				),
			).to.equal(undefined);
			expect(to.writableFinished).to.equal(true);
		});
	});

	describe('errors still pending after rejecting', () => {
		// Long enough for a pending 'error' to be emitted, as an uncaught
		// exception that fails the test, while the test is still running
		const settle = () => delay(50);

		it('should not leave the error of a node stream destroyed just before the call uncaught', async () => {
			const stream = new PassThrough();
			const expected = new Error('boom');
			stream.destroy(expected);
			expect(await capture(TarUtils.streamToBuffer(stream))).to.equal(expected);
			await settle();
		});

		it('should not leave the error of a streamx stream destroyed just before the call uncaught', async () => {
			const stream = new streamx.Readable();
			const expected = new Error('boom');
			stream.destroy(expected);
			expect(
				await capture(TarUtils.drainStream(stream as unknown as Readable)),
			).to.equal(expected);
			await settle();
		});

		it('should not leave the error of a streamx source uncaught when a destination closes', async () => {
			const from = new streamx.Readable({
				read(callback) {
					callback(null);
				},
				destroy(callback) {
					// async, so the source errors after multicastStream rejects
					setTimeout(callback, 20);
				},
			});
			from.push('data');
			const to = new PassThrough();
			to.resume();
			const promise = TarUtils.multicastStream(from as unknown as Readable, [
				to,
			]);
			setTimeout(() => to.destroy(), 10);
			expect(await capture(promise)).to.be.instanceOf(Error);
			await settle();
		});

		it('should not leave the error of a streamx source uncaught when a destination errors', async () => {
			const from = new streamx.Readable({
				read(callback) {
					callback(null);
				},
			});
			from.push('data');
			const to = new PassThrough();
			to.resume();
			const promise = TarUtils.multicastStream(from as unknown as Readable, [
				to,
			]);
			const expected = new Error('boom');
			setTimeout(() => to.destroy(expected), 10);
			expect(await capture(promise)).to.equal(expected);
			await settle();
		});
	});

	describe('multicastStream destinations that have already ended', () => {
		for (const autoDestroy of [true, false]) {
			it(`should reject without writing to them (autoDestroy: ${autoDestroy})`, async () => {
				let written = false;
				const to = new Writable({
					autoDestroy,
					write(_chunk, _encoding, callback) {
						written = true;
						callback();
					},
				});
				to.end();
				await once(to, 'finish');
				const from = new PassThrough();
				const promise = TarUtils.multicastStream(from, [to]);
				from.end('data');
				const err = await capture(promise);
				expect(err).to.be.instanceOf(Error);
				expect(err!.message).to.equal('write after end');
				expect(written).to.equal(false);
			});
		}
	});
});
