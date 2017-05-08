import * as Promise from 'bluebird'
import { assert, expect } from 'chai'
import * as mocha from 'mocha'
import * as stream from 'stream'
import * as fs from 'fs'

import * as TarUtils from '../lib'

describe('Simple utils', () => {
	it('should correctly normalize a tar entry', (done) => {
		const fn = TarUtils.normalizeTarEntry
		expect(fn('Dockerfile')).to.equal('Dockerfile')
		expect(fn('./Dockerfile')).to.equal('Dockerfile')
		expect(fn('../Dockerfile')).to.equal('../Dockerfile')
		expect(fn('/Dockerfile')).to.equal('Dockerfile')
		expect(fn('./a/b/Dockerfile')).to.equal('a/b/Dockerfile')
		done()
	})

	it('should read a stream to a buffer', (done) => {
		const readable = new stream.PassThrough()

		readable.write('test-string')
		readable.end()

		return TarUtils.streamToBuffer(readable)
			.then((buf) => {
				return expect(buf.toString()).to.equal('test-string')
			})
			.catch(done)

	})
})

