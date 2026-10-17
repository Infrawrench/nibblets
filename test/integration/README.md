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

Build the images from this checkout, then pick a machine, and a guest:

```sh
docker build -f docker/runner.Dockerfile -t nibblet/runner:dev .
docker build -f docker/server.Dockerfile -t nibblet/server:dev .

NIBBLET_TEST_MACHINE=docker pnpm test:integration   # containers
NIBBLET_TEST_MACHINE=apple pnpm test:integration    # VMs, on a Mac
NIBBLET_TEST_MACHINE=kvm pnpm test:integration      # VMs, on Linux with /dev/kvm
NIBBLET_TEST_MACHINE=hyperv pnpm test:integration   # VMs, on Windows, as a Hyper-V administrator
```

`NIBBLET_TEST_GUEST` picks the guest: `linux` (the default), `windows`
(Hyper-V and KVM) or `macos` (Apple Virtualization):

```sh
NIBBLET_TEST_MACHINE=hyperv NIBBLET_TEST_GUEST=windows NIBBLET_TEST_WINDOWS_ISO=C:\isos\win11.iso pnpm test:integration
NIBBLET_TEST_MACHINE=kvm NIBBLET_TEST_GUEST=windows NIBBLET_TEST_WINDOWS_ISO=~/isos/win11.iso pnpm test:integration
NIBBLET_TEST_MACHINE=apple NIBBLET_TEST_GUEST=macos pnpm test:integration
```

Windows and macOS are installed first, through the API as Settings would:
Windows from your ISO (an evaluation one from Microsoft does), and macOS
from Apple's restore image, which is about 15 GB and asks for an
administrator's password in a window. Each takes up to an hour. They then
install the runner from GitHub at this commit, so push it first, or set
`NIBBLET_TEST_GUEST_REF` (and `NIBBLET_TEST_GUEST_REPO` for a fork).

A Linux VM's first start makes its image from the runner image, which takes
a few minutes and about 12 GB free. The browser test only runs where the
guest has one (Linux, for now).

For Podman, point `DOCKER_HOST` at its socket and set
`NIBBLET_TEST_DOCKER_SOCKET` to it, with the images loaded into Podman.
`NIBBLET_TEST_VERBOSE=1` prints the stack's and the bridge's output.

CI runs Linux in Docker, Podman and KVM on every push, and Windows on KVM
in the Machines workflow (by hand, weekly, or on a PR labelled
`test-machines`, given a `WINDOWS_ISO_URL` repository variable). Hosted
runners have neither Hyper-V nor Apple Virtualization, so those run here.
