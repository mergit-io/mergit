# NixOS on the Hetzner server

`configuration.nix` is the host: login, firewall, Docker, boot. The services run from the compose files as before.

Install from the NixOS minimal ISO (Hetzner console: server, ISO Images, mount, then reset), as root in the installer:

```sh
parted /dev/sda -- mklabel gpt
parted /dev/sda -- mkpart bios 1MiB 2MiB
parted /dev/sda -- set 1 bios_grub on
parted /dev/sda -- mkpart ESP fat32 2MiB 514MiB
parted /dev/sda -- set 2 esp on
parted /dev/sda -- mkpart root ext4 514MiB 100%
mkfs.fat -F 32 -n ESP /dev/sda2
mkfs.ext4 -L nixos /dev/sda3
mount /dev/disk/by-label/nixos /mnt
mkdir -p /mnt/boot && mount /dev/disk/by-label/ESP /mnt/boot
nixos-generate-config --root /mnt          # only to check the hardware; configuration.nix replaces its output
# copy configuration.nix to /mnt/etc/nixos/configuration.nix, with your SSH public key filled in
nixos-install
```

Then restore the data and bring the stack up (the runbook in `../README.md`).

## Changing the host

Copy `configuration.nix` to `/etc/nixos/configuration.nix` (keeping the SSH key), then `sudo nixos-rebuild switch`.
**Turning on `live-restore` restarts Docker once, and while it is still off that stops every container**, so do it at a
quiet moment and bring the stack back straight after (`docker compose ... up -d`, the runbook in `../README.md`).

`live-restore` is meant to keep containers running through a dockerd crash. That is not yet tested here. After the
first switch, check `docker info --format '{{.LiveRestoreEnabled}}'` says `true`, then (also at a quiet moment) kill
dockerd and watch the stack:

```sh
sudo kill -9 "$(systemctl show -p MainPID --value docker)"
sleep 20; docker compose -f deploy/compose.testnet.yaml -f deploy/compose.controlplane.yaml -f deploy/compose.server.yaml ps
```

Every service should still be `Up`. If any is stopped, live-restore did not hold and the stack still needs a manual `up -d`
after a daemon crash.
