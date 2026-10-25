import assert from 'node:assert/strict';
import test from 'node:test';
import {readDraftFlushCallback,readNativeDrop,readNativeMenuAction} from '../src/native-protocol.ts';

test('native drops become string paths and finite coordinates without forwarding extra fields',() => {
  for (const input of [null,[],{paths: 'file',x: 1,y: 2},{paths: [1],x: 1,y: 2},{paths: ['a'],x: NaN,y: 2},{paths: ['a'],x: 1,y: Infinity},{paths: ['a'],x: '1',y: 2}]) assert.equal(readNativeDrop(input),undefined);
  assert.deepEqual(readNativeDrop({paths: ['中文.txt'],x: 1,y: -2,target: {nodeType: 1}}),{paths: ['中文.txt'],images: [],notice: '',x: 1,y: -2});
});

test('native drop images keep only bounded supported payloads',() => {
  const png = 'iVBORw0KGgo=';
  const drop = readNativeDrop({paths: ['/tmp/a.png'],x: 0,y: 0,notice: 'n'.repeat(600),images: [
    {name: 'a.png',mimeType: 'image/png',data: png},
    {name: 'a.svg',mimeType: 'image/svg+xml',data: png},
    {name: '',mimeType: 'image/png',data: png},
    {name: 'b.png',mimeType: 'image/png',data: ''},
    {name: 'c.png',mimeType: 'image/png',data: 7},
    {name: 'd.png',mimeType: 'image/png',data: 'x'.repeat(24 * 1024 * 1024 + 1)},
  ]})!;
  assert.deepEqual(drop.images,[{name: 'a.png',mimeType: 'image/png',data: png}]);
  assert.equal(drop.notice.length,500);
  const many = readNativeDrop({paths: [],x: 0,y: 0,images: Array.from({length: 10},(_, index) => ({name: `${index}.png`,mimeType: 'image/png',data: png}))})!;
  assert.equal(many.images.length,8);
});

test('native menu ingress accepts only the existing finite action set',() => {
  for (const action of ['new-conversation','choose-workspace','export-conversation','settings','check-updates']) assert.equal(readNativeMenuAction({action}),action);
  for (const input of [null,'settings',{action: 'delete-everything'},{action: 1}]) assert.equal(readNativeMenuAction(input),undefined);
});

test('native draft acknowledgement must be a callback',() => {
  for (const input of [null,{},true,'callback']) assert.equal(readDraftFlushCallback(input),undefined);
  let saved: boolean | undefined;
  readDraftFlushCallback((value: boolean) => {saved = value;})?.(false);
  assert.equal(saved,false);
});
