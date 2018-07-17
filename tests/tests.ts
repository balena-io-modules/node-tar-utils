import { expect } from 'chai';
import * as stream from 'stream';

import * as TarUtils from '../lib';

import * as path from 'path';

describe('Simple utils', () => {
	it('should correctly normalize a tar entry', (done) => {

		const fn = TarUtils.normalizeTarEntry;
		expect(fn('Dockerfile')).to.equal('Dockerfile');
		expect(fn('./Dockerfile')).to.equal('Dockerfile');
		expect(fn('../Dockerfile')).to.equal(`..${path.sep}Dockerfile`);
		expect(fn('/Dockerfile')).to.equal('Dockerfile');
		expect(fn('./a/b/Dockerfile')).to.equal(`a${path.sep}b${path.sep}Dockerfile`);
		done();
	});

	it('should read a stream to a buffer', (done) => {
		const readable = new stream.PassThrough();

		readable.write('test-string');
		readable.end();

		TarUtils.streamToBuffer(readable)
		.then((buf) => {
			expect(buf.toString()).to.equal('test-string');
			done();
		})
		.catch(done);

	});
});
