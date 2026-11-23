import { expect } from 'chai';
import * as fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import * as tar from 'tar-stream';
import * as TarUtils from '../lib';

const sourceTarPath = './tests/test-files/cloneTarStream.tar';
const sourceEntries = [
	'./',
	'./fileSize150K.png',
	'./fileSizeTen.txt',
	'./fileSizeZero',
	'./aFolder/',
	'./aFolder/fileSizeTen.txt',
	'./aFolder/fileSizeZero',
];

const readPack = async (pack: tar.Pack) => {
	const entries: Array<{ name: string; contents: string }> = [];
	const extract = tar.extract();
	pack.pipe(extract);
	for await (const entry of extract) {
		const chunks: Buffer[] = [];
		for await (const chunk of entry) {
			chunks.push(chunk as Buffer);
		}
		entries.push({
			name: entry.header.name,
			contents: Buffer.concat(chunks).toString(),
		});
	}
	return entries;
};

const expectOriginalEntries = (entries: Array<{ name: string }>) => {
	expect(
		entries.slice(0, sourceEntries.length).map((e) => e.name),
	).to.deep.equal(sourceEntries);
};

describe('onFinish', () => {
	describe('cloneTarStream', () => {
		it('should add entries from onFinish before finalizing', async () => {
			const pack = await TarUtils.cloneTarStream(
				fs.createReadStream(sourceTarPath),
				{
					onFinish: (p) => {
						p.entry({ name: 'extra.txt' }, 'extra contents');
					},
				},
			);
			const entries = await readPack(pack);
			expect(entries).to.have.length(sourceEntries.length + 1);
			expectOriginalEntries(entries);
			expect(entries[entries.length - 1]).to.deep.equal({
				name: 'extra.txt',
				contents: 'extra contents',
			});
		});

		it('should await an async onFinish', async () => {
			let finished = false;
			const pack = await TarUtils.cloneTarStream(
				fs.createReadStream(sourceTarPath),
				{
					onFinish: async (p) => {
						await setTimeout(10);
						p.entry({ name: 'extra.txt' }, 'async contents');
						finished = true;
					},
				},
			);
			expect(finished).to.equal(true);
			const entries = await readPack(pack);
			expect(entries).to.have.length(sourceEntries.length + 1);
			expectOriginalEntries(entries);
			expect(entries[entries.length - 1]).to.deep.equal({
				name: 'extra.txt',
				contents: 'async contents',
			});
		});

		it('should reject with the error thrown by onFinish', async () => {
			let err: unknown;
			try {
				await TarUtils.cloneTarStream(fs.createReadStream(sourceTarPath), {
					onFinish: () => {
						throw new Error('onFinish failed');
					},
				});
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.equal('onFinish failed');
		});

		it('should reject with the error rejected by an async onFinish', async () => {
			let err: unknown;
			try {
				await TarUtils.cloneTarStream(fs.createReadStream(sourceTarPath), {
					onFinish: async () => {
						await setTimeout(10);
						throw new Error('async onFinish failed');
					},
				});
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.equal('async onFinish failed');
		});

		it('should reject with the error thrown by onFinish after destroying the pack', async () => {
			let err: unknown;
			try {
				await TarUtils.cloneTarStream(fs.createReadStream(sourceTarPath), {
					onFinish: (pack) => {
						// destroying without an error emits no pack 'error'
						pack.destroy();
						throw new Error('onFinish failed');
					},
				});
			} catch (e) {
				err = e;
			}
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.equal('onFinish failed');
		});
	});

	describe('throughTarStream', () => {
		const passThrough = (
			opts?: Parameters<typeof TarUtils.throughTarStream>[1],
		) =>
			TarUtils.throughTarStream((pack, header, stream, next) => {
				stream.pipe(pack.entry(header, next));
			}, opts);

		it('should add entries from onFinish after the source entries', async () => {
			const [extract, pack] = passThrough({
				onFinish: async (p) => {
					await setTimeout(10);
					p.entry({ name: 'extra.txt' }, 'extra contents');
				},
			});
			fs.createReadStream(sourceTarPath).pipe(extract);
			const entries = await readPack(pack);
			expect(entries).to.have.length(sourceEntries.length + 1);
			expectOriginalEntries(entries);
			expect(entries[entries.length - 1]).to.deep.equal({
				name: 'extra.txt',
				contents: 'extra contents',
			});
		});

		it('should destroy the pack with the error thrown by onFinish', async () => {
			const [extract, pack] = passThrough({
				onFinish: async () => {
					await setTimeout(10);
					throw new Error('onFinish failed');
				},
			});
			const errored = new Promise<Error>((resolve) => {
				pack.once('error', resolve);
			});
			// consume the pack so that backpressure doesn't stall the source entries
			pack.resume();
			fs.createReadStream(sourceTarPath).pipe(extract);
			const err = await errored;
			expect(err).to.be.instanceOf(Error);
			expect(err.message).to.equal('onFinish failed');
			expect(pack.destroyed).to.equal(true);
		});
	});
});
