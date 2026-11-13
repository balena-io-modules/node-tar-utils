/**
 * @license
 * Copyright 2026 Balena Ltd.
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

// Type-only tests: checked by `tsc -p tsconfig.dev.json` (npm run lint), never
// run. They check that tar-utils accepts tar-stream's own (streamx) streams
// and passes tar-stream's types to callbacks.

import { PassThrough, type Readable, type Writable } from 'stream';
import type * as tar from 'tar-stream';

import * as TarUtils from '../../lib';

// Type-only assertion: the argument must be assignable to T
function expectType<T>(value: T): T {
	return value;
}

declare const nodeReadable: Readable;
declare const nodeWritable: Writable;
declare const pack: tar.Pack;
declare const entryStream: TarUtils.TarEntryStream;

export async function streamUtils() {
	expectType<Buffer>(await TarUtils.streamToBuffer(entryStream));
	expectType<Buffer>(await TarUtils.streamToBuffer(nodeReadable));
	expectType<Buffer>(await TarUtils.streamToBuffer(pack));
	// @ts-expect-error not a stream
	await TarUtils.streamToBuffer('foo');

	await TarUtils.drainStream(entryStream);
	await TarUtils.drainStream(nodeReadable);

	expectType<Writable>(await TarUtils.pipePromise(pack, nodeWritable));
	expectType<PassThrough>(
		await TarUtils.pipePromise(nodeReadable, new PassThrough()),
	);

	// streamx streams (like tar.Pack) can only pipe to one destination
	// @ts-expect-error multicastStream needs a node Readable
	await TarUtils.multicastStream(pack, [nodeWritable, new PassThrough()]);
	await TarUtils.multicastStream(nodeReadable, [nodeWritable]);

	expectType<tar.Pack>(await TarUtils.cloneTarStream(pack));
	expectType<tar.Pack>(await TarUtils.cloneTarStream(nodeReadable));
}

export async function cloneTarStreamCallbacks() {
	await TarUtils.cloneTarStream(pack, {
		onEntry: async ($pack, header, stream) => {
			expectType<tar.Pack>($pack);
			expectType<tar.Header>(header);
			expectType<number>(header.size);
			// @ts-expect-error header is a tar.Header, not any
			expectType<string>(header);
			expectType<TarUtils.TarEntryStream>(stream);
			// @ts-expect-error the entry stream is a streamx Readable, not a node one
			expectType<Readable>(stream);
			$pack.entry(
				{ ...header, name: `a/${header.name}` },
				await TarUtils.streamToBuffer(stream),
			);
		},
		onFinish: ($pack) => {
			$pack.entry({ name: 'extra' }, 'contents');
		},
	});
}

export function throughTarStreamCallbacks() {
	const [extract, outPack] = TarUtils.throughTarStream(
		async ($pack, header, stream, next) => {
			expectType<tar.Pack>($pack);
			expectType<tar.Header>(header);
			// @ts-expect-error header is a tar.Header, not any
			expectType<string>(header);
			expectType<TarUtils.TarEntryStream>(stream);
			expectType<TarUtils.TarEntryCallback>(next);
			if (header.name === 'skip') {
				await TarUtils.drainStream(stream);
				next();
				return;
			}
			if (header.name === 'error') {
				next(new Error('error'));
				next(null);
				// @ts-expect-error next only accepts an Error (or nothing/null)
				next('error');
				return;
			}
			stream.pipe($pack.entry({ ...header, name: `a/${header.name}` }, next));
		},
	);
	expectType<tar.Extract>(extract);
	expectType<tar.Pack>(outPack);
}
