# Integration tests

Nibblets through a real server, in real machines: `nibblets.test.ts` brings
up a whole stack of its own (`stack.ts`) beside whatever else is on the
engine, with a fake Anthropic API (`fake-anthropic.ts`) where the credential
proxy would be, so the real Claude Code harness runs with no credentials. It
makes a nibblet, has it answer, opens its browser, snapshots and restores
it, stops and wakes it, has it spawn a sub-agent, and deletes it.

The stack is labelled as its own (`NIBBLET_STACK`), so its server never
touches another stack's nibblets, and it doesn't prune images or update
harness CLIs. It's all removed afterwards.

Build the images from this checkout, then pick a machine:

```sh
docker build -f docker/runner.Dockerfile -t nibblet/runner:dev .
docker build -f docker/server.Dockerfile -t nibblet/server:dev .

NIBBLET_TEST_MACHINE=docker pnpm test:integration   # containers
NIBBLET_TEST_MACHINE=apple pnpm test:integration    # Linux VMs, on a Mac
NIBBLET_TEST_MACHINE=kvm pnpm test:integration      # Linux VMs, on Linux with /dev/kvm
NIBBLET_TEST_MACHINE=hyperv pnpm test:integration   # Linux VMs, on Windows, as a Hyper-V administrator
```

For Podman, point `DOCKER_HOST` at its socket and set
`NIBBLET_TEST_DOCKER_SOCKET` to it, with the images loaded into Podman.
`NIBBLET_TEST_VERBOSE=1` prints the stack's and the bridge's output.

A VM's first start makes its Linux image from the runner image, which takes
a few minutes and about 12 GB free. CI runs Docker, Podman and KVM; Apple's
and Hyper-V's hypervisors aren't on hosted runners, so those run here.
