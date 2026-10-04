import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_UNIT, listenerOwners, portOf, serviceUid, trustedListener } from '../hooks/lib/listener.ts';

// The mod takes commands from whatever answers on session-events' port, and
// the port is unprivileged. A systemd .socket unit holds it as root, so the
// mod says hello only while every socket listening there is root's (T-F1).

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const line = (local: string, st: string, uid: number) =>
  `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 1479962374 1 0000000000000000 100 0 0 10 0`;

// 7685 is 0x1E05.
const tcp = [HEAD, line('0100007F:1E05', '0A', 0), line('0100007F:9C40', '0A', 1000), line('0100007F:1E05', '01', 1000)].join('\n');
const tcp6 = [HEAD, line('00000000000000000000000000000000:1E05', '0A', 0)].join('\n');

test('listenerOwners lists the uid of each LISTEN socket on the port, ignoring connections', () => {
  assert.deepEqual(listenerOwners(tcp, 7685), [0]);
  assert.deepEqual(listenerOwners(tcp6, 7685), [0]);
  assert.deepEqual(listenerOwners(tcp, 40000), [1000]);
  assert.deepEqual(listenerOwners(tcp, 1), []);
  assert.deepEqual(listenerOwners('', 7685), []);
});

test('portOf reads the port from the URL, with the scheme default', () => {
  assert.equal(portOf('http://127.0.0.1:7685'), 7685);
  assert.equal(portOf('http://[::1]:9000/'), 9000);
  assert.equal(portOf('http://localhost'), 80);
  assert.equal(portOf('https://localhost'), 443);
  assert.equal(portOf('not a url'), 0);
});

const files = (t4: string, t6: string) => async (path: string) => {
  if (path === '/proc/net/tcp') return t4;
  if (path === '/proc/net/tcp6') return t6;
  throw new Error(`unexpected ${path}`);
};

const cases: [string, string, string, boolean][] = [
  ['root listens on both families', tcp, tcp6, true],
  ['root listens on one family only', [HEAD].join('\n'), tcp6, true],
  ['another account listens beside root', tcp, [HEAD, line('00000000000000000000000000000000:1E05', '0A', 1001)].join('\n'), false],
  ['only another account listens', [HEAD, line('0100007F:1E05', '0A', 1000)].join('\n'), HEAD, false],
  ['nothing listens', HEAD, HEAD, false],
];
for (const [name, t4, t6, want] of cases) {
  test(`trustedListener: ${name} -> ${want}`, async () => {
    assert.equal(await trustedListener(files(t4, t6), 7685), want);
  });
}

test('trustedListener refuses when the tables cannot be read', async () => {
  assert.equal(await trustedListener(async () => { throw new Error('EACCES'); }, 7685), false);
});

test('trustedListener reads tcp6 even when tcp is unreadable', async () => {
  const read = async (path: string) => {
    if (path === '/proc/net/tcp6') return tcp6;
    throw new Error('ENOENT');
  };
  assert.equal(await trustedListener(read, 7685), true);
});

// A rollback to a deb without session-events.socket has the old session-events
// bind the port itself, as the service's User=. Mods already running 0.3.0 must
// keep talking to it, so that one uid is trusted beside root; any other is not.
const UNIT = '[Unit]\nDescription=session-events\n\n[Service]\nExecStart=/usr/local/bin/session-events\nUser=wizard\n\n[Install]\nWantedBy=multi-user.target\n';
const PASSWD = 'root:x:0:0:root:/root:/bin/bash\nwizard:x:1000:1000:Viktor:/home/wizard:/bin/zsh\nemo:x:1001:1001::/home/emo:/bin/bash\n';

function box(t6: string, unit: string | null, passwd = PASSWD) {
  return async (path: string) => {
    if (path === '/proc/net/tcp') return HEAD;
    if (path === '/proc/net/tcp6') return t6;
    if (path === SERVICE_UNIT && unit !== null) return unit;
    if (path === '/etc/passwd') return passwd;
    throw new Error(`ENOENT ${path}`);
  };
}
const listening = (uid: number) => [HEAD, line('00000000000000000000000000000000:1E05', '0A', uid)].join('\n');

const owners: [string, number, string | null, boolean][] = [
  ['root', 0, UNIT, true],
  ['the service user', 1000, UNIT, true],
  ['another account', 1001, UNIT, false],
  ['the service user with no unit file', 1000, null, false],
  ['root with no unit file', 0, null, true],
  ['a numeric User=', 1001, UNIT.replace('User=wizard', 'User=1001'), true],
  ['a User= that /etc/passwd does not name', 1000, UNIT.replace('User=wizard', 'User=ghost'), false],
  ['a unit with no User= (runs as root)', 1000, UNIT.replace('User=wizard\n', ''), false],
];
for (const [name, uid, unit, want] of owners) {
  test(`trustedListener: a listener owned by ${name} -> ${want}`, async () => {
    assert.equal(await trustedListener(box(listening(uid), unit), 7685), want);
  });
}

test('serviceUid takes the last User= of the [Service] section only', async () => {
  const unit = '[Unit]\nUser=emo\n[Service]\nUser=root\nUser=wizard\n[Install]\nUser=emo\n';
  assert.equal(await serviceUid(box(HEAD, unit)), 1000);
  assert.equal(await serviceUid(box(HEAD, '[Service]\n  User = emo  \n')), 1001);
  assert.equal(await serviceUid(box(HEAD, null)), undefined);
  assert.equal(await serviceUid(box(HEAD, UNIT, 'garbage')), undefined);
});
