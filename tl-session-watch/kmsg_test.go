package main

import "testing"

// The two kernel lines a pane cap kill writes, copied from the devvm journal
// for the 2026-09-25 17:29 kill of claude 3908023.
const (
	memcgKillLine = "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-7c5e34a1-68f7-4c1c-be58-daa94422297b.scope,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-7c5e34a1-68f7-4c1c-be58-daa94422297b.scope,task=claude,pid=3908023,uid=1000"
	killedLine    = "Memory cgroup out of memory: Killed process 3908023 (claude) total-vm:5688248kB, anon-rss:420556kB, file-rss:101196kB, shmem-rss:0kB, UID:1000 pgtables:2120kB oom_score_adj:200"
)

func TestAMemcgKillNamesItsPid(t *testing.T) {
	pid, ok := parseMemcgKill(memcgKillLine)
	if !ok || pid != 3908023 {
		t.Fatalf("want pid 3908023, got %d %v", pid, ok)
	}
}

// The task field is not trusted: a claude's comm has been seen carrying its
// version string, so the pid is matched against the claudes the watcher found
// by exe instead.
func TestAMemcgKillIsReadWhateverTheTaskIsCalled(t *testing.T) {
	line := "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg=/x.scope,task_memcg=/x.scope,task=2.1.177,pid=42,uid=1000"
	if pid, ok := parseMemcgKill(line); !ok || pid != 42 {
		t.Fatalf("want pid 42, got %d %v", pid, ok)
	}
}

// A box-wide kernel OOM means the machine is out of memory, and resuming into
// that invites the next kill. Only a cgroup limit counts.
func TestABoxWideKillIsNotAPaneCapKill(t *testing.T) {
	line := "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/x.scope,task=claude,pid=7,uid=1000"
	if _, ok := parseMemcgKill(line); ok {
		t.Fatal("a CONSTRAINT_NONE kill must not read as a pane cap kill")
	}
}

func TestOtherKernelLinesAreIgnored(t *testing.T) {
	for _, line := range []string{killedLine, "", "oom-kill:constraint=CONSTRAINT_MEMCG,task=claude", "eth0: link up"} {
		if _, ok := parseMemcgKill(line); ok {
			t.Errorf("want no kill from %q", line)
		}
	}
}

// /dev/kmsg hands back one record per read: "<prio>,<seq>,<usec>,<flags>;<text>"
// with optional continuation lines after a newline.
func TestAKmsgRecordYieldsItsText(t *testing.T) {
	got := kmsgText("3,98231,1790370554000000,-;" + memcgKillLine + "\n SUBSYSTEM=memory\n")
	if got != memcgKillLine {
		t.Fatalf("want the message text, got %q", got)
	}
	if kmsgText("no separator here") != "" {
		t.Error("want nothing from a malformed record")
	}
}
