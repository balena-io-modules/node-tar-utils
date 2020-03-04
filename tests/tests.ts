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
import { PassThrough, Readable, Writable } from 'stream';

import * as Bluebird from 'bluebird';
import * as fs from 'fs';
import * as tar from 'tar-stream';

import * as TarUtils from '../lib';

describe('Simple utils', () => {
	it('should correctly normalize a tar entry', done => {
		const testCases = [
			// input, expected output
			// a slash is also programmatically appended to every input test case
			['', ''],
			['.', '.'],
			['..', '..'],
			['/', '.'],
			['/.', '.'],
			['/..', '.'], // root's parent? hmm
			['Dockerfile', 'Dockerfile'],
			['./Dockerfile', 'Dockerfile'],
			['../Dockerfile', `../Dockerfile`],
			['/Dockerfile', 'Dockerfile'],
			['./a/b/Dockerfile', `a/b/Dockerfile`],
			['./a/../b/Dockerfile', `b/Dockerfile`],
			['///a//b/Dockerfile', `a/b/Dockerfile`],
			['a/./b/Dockerfile', `a/b/Dockerfile`],
		];
		for (let [input, expected] of testCases) {
			let result = TarUtils.normalizeTarEntry(input);
			expect(result).to.equal(
				expected,
				`normalizeTarEntry('${input}') returned '${result}', expected '${expected}'`,
			);
			if (input === '') {
				continue;
			}
			// adding a trailing slash to the input should not alter the output
			input += '/';
			result = TarUtils.normalizeTarEntry(input);
			expect(result).to.equal(
				expected,
				`normalizeTarEntry('${input}') returned '${result}' expected '${expected}'`,
			);
		}
		done();
	});

	it('should read a stream to a buffer', done => {
		const readable = new PassThrough();

		readable.write('test-string');
		readable.end();

		TarUtils.streamToBuffer(readable)
			.then(buf => {
				expect(buf.toString()).to.equal('test-string');
				done();
			})
			.catch(done);
	});
});

describe('pipeStream', function() {
	const hwm = 16333; // high water mark
	const sourceBuf = Buffer.alloc(71000, '0123456789');

	it('should resolve when the pipe operation completes', () => {
		const fromStream = new MockReadable({ highWaterMark: hwm }, sourceBuf);
		const toStream = new MockWritable({ highWaterMark: hwm });

		return TarUtils.pipePromise(fromStream, toStream).then(() => {
			const destBuf = Buffer.concat(toStream.chunks);
			expect(sourceBuf.compare(destBuf)).to.equal(0);
		});
	});
});

describe('cloneTarStream', function() {
	const hwm = 16333; // high water mark

	it('should successfully clone a tar file', () => {
		const sourceTarStream = fs.createReadStream(
			'./tests/test-files/cloneTarStream.tar',
			{
				highWaterMark: hwm,
			},
		);
		const expectedEntries = [
			['./', 0],
			['./fileSize150K.png', 150524],
			['./fileSizeTen.txt', 10],
			['./fileSizeZero', 0],
			['./aFolder/', 0],
			['./aFolder/fileSizeTen.txt', 10],
			['./aFolder/fileSizeZero', 0],
		];

		return TarUtils.cloneTarStream(sourceTarStream).then((pack: tar.Pack) => {
			return new Bluebird((resolve, reject) => {
				let i = 0;
				const extract = tar.extract();
				pack.on('error', reject);
				extract.on('error', reject);
				extract.on(
					'entry',
					(header: tar.Headers, stream: Readable, callback: () => void) => {
						try {
							const [expectedName, expectedSize] = expectedEntries[i++];
							expect(header.name).to.equal(expectedName);
							expect(header.size).to.equal(expectedSize);
						} catch (error) {
							reject(error);
						}
						TarUtils.drainStream(stream).then(callback, callback);
					},
				);
				extract.once('finish', resolve);
				pack.pipe(extract);
			});
		});
	});
});

describe('multicastStream', function() {
	this.timeout(60000);
	const sourceBuf = Buffer.alloc(71011, '0123456789');
	const hwm = 16384; // high water mark

	it('should successfully multicast a producer stream to different-pace consumers', () => {
		const fromStream = new MockReadable({ highWaterMark: hwm }, sourceBuf);
		const toStreams: MockWritable[] = [];
		const nStreams = 3;
		for (let i = 0; i < nStreams; ++i) {
			toStreams.push(
				new MockWritable({ highWaterMark: Math.ceil(hwm / (i + 1)) }, i * 10),
			);
		}

		return TarUtils.multicastStream(fromStream, toStreams).then(() => {
			for (const toStream of toStreams) {
				const dest = Buffer.concat(toStream.chunks);
				expect(toStream.chunks.length).to.equal(
					Math.ceil(sourceBuf.length / hwm),
				);
				expect(sourceBuf.compare(dest)).to.equal(0);
			}
		});
	});

	it('should resolve for an empty list of destination streams', () => {
		const fromStream = new MockReadable({ highWaterMark: hwm }, sourceBuf);
		return TarUtils.multicastStream(fromStream, []);
	});

	it('should reject when a destination stream emits an error', () => {
		const fromStream = new MockReadable({ highWaterMark: hwm }, sourceBuf);
		const toStreams: MockWritable[] = [];
		const nStreams = 3;
		for (let i = 0; i < nStreams; ++i) {
			toStreams.push(new MockWritable({ highWaterMark: hwm }, 0, i + 1));
		}
		return TarUtils.multicastStream(fromStream, toStreams)
			.then(() => {
				throw new Error(
					'multicastStream call should have rejected, but succeeded',
				);
			})
			.catch((error: Error) => {
				expect(error.message).to.equal('write count is 1');
			});
	});

	it('should reject when the source stream emits an error', () => {
		const fromStream = new MockReadable({ highWaterMark: hwm }, sourceBuf, 2);
		const toStreams: MockWritable[] = [];
		const nStreams = 3;
		for (let i = 0; i < nStreams; ++i) {
			toStreams.push(new MockWritable({ highWaterMark: hwm }, 0));
		}
		return TarUtils.multicastStream(fromStream, toStreams)
			.then(() => {
				throw new Error(
					'multicastStream call should have rejected, but succeeded',
				);
			})
			.catch((error: Error) => {
				expect(error.message).to.equal('read count is 2');
			});
	});
});

class MockReadable extends Readable {
	public readCount = 0;
	public index = 0;

	constructor(
		opts: object,
		public sourceBuf: Buffer,
		public errorOnCount = -1,
	) {
		super(opts);
	}
	public _read(size: number) {
		if (this.readCount++ === this.errorOnCount) {
			this.emit('error', new Error(`read count is ${this.errorOnCount}`));
		} else {
			let pushOK = true;
			while (pushOK) {
				if (this.index >= this.sourceBuf.length) {
					this.push(null);
					break;
				} else {
					pushOK = this.push(
						this.sourceBuf.slice(this.index, this.index + size),
					);
					this.index += size;
				}
			}
		}
	}
}

class MockWritable extends Writable {
	public writeCount = 0;
	public chunks: Buffer[] = [];

	constructor(opts: object, public delay = 0, public errorOnCount = -1) {
		super(opts);
	}

	public _write(
		chunk: Buffer,
		_encoding: any,
		callback: (error: Error | null) => void,
	) {
		let error: Error | null;
		if (this.writeCount++ === this.errorOnCount) {
			error = new Error(`write count is ${this.errorOnCount}`);
		} else {
			this.chunks.push(chunk);
			error = null;
		}
		if (this.delay < 1) {
			process.nextTick(callback, error);
		} else {
			setTimeout(callback, this.delay, error);
		}
	}
}
