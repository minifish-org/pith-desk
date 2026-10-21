import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerSession} from '../src/server-session.ts';

function setup(t, handler, navigation = 'reload', saved = '') {
  const values = new Map(saved ? [['pith-desk-server-lease',saved]] : []);
  const originals = ['window','sessionStorage'].map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  let reloads = 0, ready = 0, revoked = 0;
  const panels = [], requests = [];
  Object.defineProperty(globalThis,'window',{configurable: true,value: {location: {reload() {reloads++;}}}});
  Object.defineProperty(globalThis,'sessionStorage',{configurable: true,value: {getItem: key => values.get(key),setItem: (key,value) => values.set(key,value),removeItem: key => values.delete(key)}});
  t.mock.method(performance,'getEntriesByType',() => [{type: navigation}]);
  t.mock.method(globalThis,'fetch',async (path, options) => {
    const request = {path,body: JSON.parse(options.body),headers: options.headers};requests.push(request);
    return handler(request);
  });
  const session = createServerSession();
  t.after(() => {session.dispose();for (const [name,descriptor] of originals) {if (descriptor) Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const ui = {openServerAccess(state,actions) {const panel = {state,actions,destroy() {}};panels.push(panel);return panel;}};
  return {session,values,panels,requests,start: () => session.start(ui,() => ready++,() => revoked++),counts: () => ({reloads,ready,revoked})};
}

test('Server sends the login token once and reloads with a cookie, without storing the token',async t => {
  const fixture = setup(t,request => Response.json(request.path === '/api/server/session' ? {authenticated: false} : {ok: true}));
  await fixture.start();
  assert.equal(fixture.panels.at(-1).state.phase,'login');
  assert.throws(() => fixture.session.headers(),/Reconnect/);
  await fixture.panels.at(-1).actions.onLogin('private-server-token');
  assert.deepEqual(fixture.requests.at(-1).body,{token: 'private-server-token'});
  assert.equal(fixture.requests.at(-1).headers.has('Authorization'),false);
  assert.equal(fixture.values.size,0);
  assert.deepEqual(fixture.counts(),{reloads: 1,ready: 0,revoked: 0});
});

test('reload rotates a lease, numbers mutations, and suspends the old page after revocation',async t => {
  let leases = 0;
  const fixture = setup(t,request => {
    if (request.path === '/api/server/session') return Response.json({authenticated: true});
    if (request.path === '/api/server/lease') return Response.json({lease: 'lease-' + ++leases,expiresIn: 45});
    return Response.json({ok: true});
  },'reload','previous-lease');
  await fixture.start();
  assert.equal(fixture.requests[1].body.resume,'previous-lease');
  assert.equal(fixture.values.get('pith-desk-server-lease'),'lease-1');
  assert.equal(fixture.session.headers(true).get('X-Desk-Request'),'1');
  assert.equal(fixture.session.headers(true).get('X-Desk-Request'),'2');
  assert.equal(fixture.session.headers().get('X-Desk-Lease'),'lease-1');
  assert.deepEqual(fixture.session.protocols(),['pith-desk','lease.lease-1']);
  fixture.session.failed(409);
  assert.deepEqual(fixture.counts(),{reloads: 0,ready: 1,revoked: 1});
  assert.equal(fixture.values.size,0);
  assert.throws(() => fixture.session.headers(true),/Reconnect/);
  assert.equal(fixture.panels.at(-1).state.phase,'blocked');
  await fixture.panels.at(-1).actions.onContinue();
  assert.equal(fixture.requests.at(-1).body.takeover,true);
  assert.deepEqual(fixture.counts(),{reloads: 1,ready: 1,revoked: 1});
});

test('a duplicated tab waits for Continue here, which takes control in one action',async t => {
  const fixture = setup(t,request => {
    if (request.path === '/api/server/session') return Response.json({authenticated: true});
    if (request.body.takeover) return Response.json({lease: 'new-page-lease',expiresIn: 45});
    return Response.json({error: 'Another page controls Pith Desk.'},{status: 409});
  },'navigate','copied-lease');
  await fixture.start();
  assert.equal(fixture.requests[1].body.resume,'');
  assert.equal(fixture.requests[1].body.takeover,false);
  assert.equal(fixture.panels.at(-1).state.phase,'blocked');
  assert.equal(fixture.panels.at(-1).state.error,'');
  await fixture.session.check();
  assert.equal(fixture.requests.length,2);
  assert.equal(fixture.counts().ready,0);
  await fixture.panels.at(-1).actions.onContinue();
  assert.deepEqual(fixture.requests.at(-1).body,{resume: '',takeover: true});
  assert.equal(fixture.counts().ready,1);
});

test('a late heartbeat from a revoked lease cannot suspend its replacement',async t => {
  let leases = 0, finishHeartbeat;
  const fixture = setup(t,request => {
    if (request.path === '/api/server/session') return Response.json({authenticated: true});
    if (request.path === '/api/server/lease') return Response.json({lease: 'lease-' + ++leases,expiresIn: 45});
    return new Promise(resolve => {finishHeartbeat = resolve;});
  });
  await fixture.start();
  const checking = fixture.session.check();
  fixture.session.failed(409);
  await fixture.panels.at(-1).actions.onContinue();
  finishHeartbeat(Response.json({error: 'Old lease expired.'},{status: 409}));
  await checking;
  assert.equal(fixture.session.headers().get('X-Desk-Lease'),'lease-2');
  assert.deepEqual(fixture.counts(),{reloads: 1,ready: 1,revoked: 1});
});
