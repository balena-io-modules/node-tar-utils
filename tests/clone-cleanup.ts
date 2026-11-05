import { expect } from 'chai';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type * as tar from 'tar-stream';

import * as TarUtils from '../lib';

// A small highWaterMark makes the source stall under backpressure soon after
// extract stops consuming, which is what used to leak it
const highWaterMark = 512;

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	return undefined;
}

// Returns a promise that resolves once the stream has closed, whether or not it
// was destroyed with an error ('once' from node:events would reject on that
// error). Call it before the stream can close.
function whenClosed(stream: Readable): Promise<void> {
	return new Promise<void>((resolve) => stream.once('close', resolve));
}

describe('cloneTarStream cleanup', () => {
	let tmpDir: string;
	before(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'tar-utils-'));
	});
	after(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('should destroy the source and reject with the parse error when the source is not a valid tar', async () => {
		const junkFile = join(tmpDir, 'junk');
		await writeFile(junkFile, Buffer.alloc(5 * 1024 * 1024, 'x'));
		const source = createReadStream(junkFile, { highWaterMark });

		const sourceClosed = whenClosed(source);

		const err = await captureError(TarUtils.cloneTarStream(source));
		expect(err).to.be.instanceOf(Error);
		expect((err as Error).message).to.match(/Invalid tar header/);

		await sourceClosed;
		expect(source.destroyed).to.equal(true);
		// Only the first chunks were read, rather than the whole file
		expect(source.bytesRead).to.be.lessThan(1024 * 1024);
	});

	it('should destroy the source and reject with the error thrown by onEntry', async () => {
		const source = createReadStream(
			join(__dirname, 'test-files', 'cloneTarStream.tar'),
			{ highWaterMark },
		);
		const sourceClosed = whenClosed(source);
		const thrown = new Error('boom');

		const err = await captureError(
			TarUtils.cloneTarStream(source, {
				onEntry: () => {
					throw thrown;
				},
			}),
		);
		expect(err).to.equal(thrown);

		await sourceClosed;
		expect(source.destroyed).to.equal(true);
	});

	it('should reject with the source error and destroy the pack when the source errors', async () => {
		// The start of a valid archive, so that the source fails mid-stream
		const start = (
			await readFile(join(__dirname, 'test-files', 'cloneTarStream.tar'))
		).subarray(0, 4096);

		const source = new PassThrough();
		const sourceError = new Error('source failed');
		let clonePack: tar.Pack | undefined;
		const promise = TarUtils.cloneTarStream(source, {
			onEntry: (pack, _header, stream) => {
				clonePack = pack;
				source.destroy(sourceError);
				stream.resume();
			},
		});
		source.write(start);

		const err = await captureError(promise);
		expect(err).to.equal(sourceError);

		expect(clonePack).to.not.equal(undefined);
		if (!clonePack!.destroyed) {
			await once(clonePack as unknown as Readable, 'close');
		}
		expect(clonePack!.destroyed).to.equal(true);
	});

	it('should reject with the source error when the source errors part way through an entry', async () => {
		// The first 4096 bytes include the header and the start of the data of an
		// entry that is larger than that
		const start = (
			await readFile(join(__dirname, 'test-files', 'cloneTarStream.tar'))
		).subarray(0, 4096);
		const sourceError = new Error('source failed');
		let sent = false;
		const source = new Readable({
			read() {
				// Fail the second time data is requested, after the first chunk
				// has been consumed
				if (!sent) {
					sent = true;
					this.push(start);
				} else {
					this.destroy(sourceError);
				}
			},
		});

		const err = await captureError(TarUtils.cloneTarStream(source));
		expect(err).to.equal(sourceError);
		// Let any error events emitted by the destroyed streams surface, mocha
		// fails the test if one is left unhandled
		await new Promise((resolve) => setImmediate(resolve));
	});
});
