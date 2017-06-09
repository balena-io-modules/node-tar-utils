import * as Promise from 'bluebird'
import * as path from 'path'
import * as fs from 'mz/fs'
import * as klaw from 'klaw'
import * as tar from 'tar-stream'

/**
 * normalizeTarEntry: Depending on how the tar archive was created,
 * filenames can be presented in several different forms, and this function
 * aims to make them all similar, for example;
 *  * ./Dockerfile -> Dockerfile
 *  * /Dockerfile -> Dockerfile
 *  * Dockerfile -> Dockerfile
 *  * ./a/b/Dockerfile -> a/b/Dockerfile
 */
export function normalizeTarEntry(name: string): string {
  const normalized = path.normalize(name)
  if (path.isAbsolute(normalized)) {
    return normalized.substr(normalized.indexOf('/') + 1)
  }
  return normalized
}

/**
 * streamToBuffer: Given a stream, read it into a buffer
 * @param stream
 * @param size
 */
export function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffer: Buffer = new Buffer('')
    stream.on('data', (data: Buffer) => buffer = Buffer.concat([buffer, data]))
    stream.on('end', () => resolve(buffer))
    stream.on('error', reject)
  })
}

/**
 * Go through an entire directory, splitting the entries out
 * into a list of paths to work through.
 */
export const directoryToFiles = (dirPath: string): Promise<string[]> => {
	return new Promise<string[]>((resolve, reject) => {
		const files: string[] = []

		// Walk the directory
		klaw(dirPath)
		.on('data', (item: klaw.Item) => {
			if (!item.stats.isDirectory()) {
				files.push(item.path)
			}
		})
		.on('end', () => {
			resolve(files)
		})
		.on('error', reject)
	})
}

export function tarDirectory(directory: string): Promise<NodeJS.ReadableStream> {
	const pack = tar.pack()

	return directoryToFiles(directory)
		.map((file: string) => {
			return fs.stat(file)
				.then((stat) => {
					return new Promise((resolve, reject) => {
						console.log(file)

						const relative =  path.relative(path.resolve(directory), file);

						const entry = pack.entry({ name: relative, size: stat.size }, (err) => {
							if (err != null) {
								reject(err)
							}
							resolve()
						})
						fs.createReadStream(file).pipe(entry)
					})
				})
		}, { concurrency: 1 })
		.then(() => {
			pack.finalize()
		})
		.return(pack)
}
