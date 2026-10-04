// Whether the server on session-events' port is the real one, checked before
// every hello.
//
// The mod runs the commands the server hands it (a prompt typed as the user,
// a permission allowed), and the port is above 1024, so any account on the box
// that bound it while session-events was down would be obeyed. Since the
// session-events.socket unit, systemd binds the port as root and holds it
// across restarts, so a socket listening there that is not root's is not
// session-events. The kernel's socket tables say who owns each listener.

const LISTEN = '0A';

export type ReadFile = (path: string) => Promise<string>;

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

// True when something listens on `port` and every listener there is root's.
// A table that cannot be read counts as empty: the family is not there.
export async function trustedListener(read: ReadFile, port: number): Promise<boolean> {
  const owners: number[] = [];
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      owners.push(...listenerOwners(await read(path), port));
    } catch {
      // No such family on this box.
    }
  }
  return owners.length > 0 && owners.every((uid) => uid === 0);
}
