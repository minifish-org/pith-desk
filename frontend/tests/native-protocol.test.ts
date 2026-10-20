import assert from 'node:assert/strict';
import test from 'node:test';
import {readDraftFlushCallback,readNativeDrop,readNativeMenuAction} from '../src/native-protocol.ts';

test('native drops become string paths and finite coordinates without forwarding extra fields',() => {
  for (const input of [null,[],{paths: 'file',x: 1,y: 2},{paths: [1],x: 1,y: 2},{paths: ['a'],x: NaN,y: 2},{paths: ['a'],x: 1,y: Infinity},{paths: ['a'],x: '1',y: 2}]) assert.equal(readNativeDrop(input),undefined);
  assert.deepEqual(readNativeDrop({paths: ['中文.txt'],x: 1,y: -2,target: {nodeType: 1}}),{paths: ['中文.txt'],x: 1,y: -2});
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
