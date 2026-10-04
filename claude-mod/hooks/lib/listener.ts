// Whether the server on session-events' port is the real one, checked before
// every hello.
//
// The mod runs the commands the server hands it (a prompt typed as the user,
// a permission allowed), and the port is above 1024, so any account on the box
// that bound it while session-events was down would be obeyed. Since the
// session-events.socket unit, systemd binds the port as root and holds it
// across restarts, so a socket listening there that is not root's is not
// session-events. The kernel's socket tables say who owns each listener.
//
// One other owner is trusted: the User= of session-events.service. A deb
// from before the socket unit (the automatic deploy rollback installs one)
// has session-events bind the port itself as that user, and a mod that
// refused it would stay silent until its session restarted. The unit file
// is root's and every deb ships it; any other account is still refused.

const LISTEN = '0A';

export type ReadFile = (path: string) => Promise<string>;

export const SERVICE_UNIT = '/etc/systemd/system/session-events.service';

// The uids owning the LISTEN sockets on `port` in one /proc/net/tcp or tcp6 table.
export function listenerOwners(table: string, port: number): number[] {
  const owners: number[] = [];
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    const local = f[1];
    if (local === undefined || f[3] !== LISTEN) continue;
    const hex = local.slice(local.lastIndexOf(':') + 1);
    if (Number.parseInt(hex, 16) !== port) continue;
    const uid = Number(f[7]);
    if (Number.isInteger(uid)) owners.push(uid);
  }
  return owners;
}

// The port a server URL names, or the scheme's default; 0 when it is no URL.
export function portOf(url: string): number {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

// The uid session-events.service runs as when its unit names a User=, by
// number or by its /etc/passwd name; undefined when it names none (root) or
// the files cannot be read.
export async function serviceUid(read: ReadFile): Promise<number | undefined> {
  let user: string | undefined;
  try {
    let section = '';
    for (const raw of (await read(SERVICE_UNIT)).split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[')) section = line;
      const m = /^User\s*=\s*(\S+)$/.exec(line);
      if (m && section === '[Service]') user = m[1];
    }
  } catch {
    return undefined;
  }
  if (user === undefined) return undefined;
  if (/^\d+$/.test(user)) return Number(user);
  try {
    for (const entry of (await read('/etc/passwd')).split('\n')) {
      const f = entry.split(':');
      if (f[0] === user && f[2] !== undefined && /^\d+$/.test(f[2])) return Number(f[2]);
    }
  } catch {
    // No passwd to resolve the name: only root is trusted.
  }
  return undefined;
}

// True when something listens on `port` and every listener there is root's
// or the session-events service user's. A table that cannot be read counts
// as empty: the family is not there.
export async function trustedListener(read: ReadFile, port: number): Promise<boolean> {
  const owners: number[] = [];
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      owners.push(...listenerOwners(await read(path), port));
    } catch {
      // No such family on this box.
    }
  }
  if (owners.length === 0) return false;
  if (owners.every((uid) => uid === 0)) return true;
  const service = await serviceUid(read);
  return service !== undefined && owners.every((uid) => uid === 0 || uid === service);
}
