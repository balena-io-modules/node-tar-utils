require('ts-node/register'); a = require('./lib/index');a.tarDirectory('./node_modules').then((stream) => { stream.pipe(require('fs').createWriteStream('test.tar')) }).catch((err) => console.log('error: ', err))

