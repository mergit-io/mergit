# NixOS config for the Hetzner server (CPX32). Installed from the minimal ISO; see README.md next to this file.
# The services themselves still run from the docker compose files (deploy/server/README.md): NixOS provides the host,
# the firewall, Docker and the login, so the machine can be rebuilt from this file instead of by hand.
{ config, lib, pkgs, ... }:

let
  # Public keys that may log in as viscous. Public keys only, never a private one.
  sshKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILZnFeqYfJPwU5VvZRDEjjJL945mZcNWybqNtIRydVjG viscous-laptop"
  ];
  # The key GitHub Actions deploys with (.github/workflows/deploy.yml). It can run deploy/server/update.sh and nothing
  # else: no shell, no forwarding. The private half is only in the DEPLOY_SSH_KEY repository secret.
  deployKey = ''restrict,command="cd ~/mergit/mergit && deploy/server/update.sh \"''${SSH_ORIGINAL_COMMAND:-all}\"" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMcCyOrZI7AUZPdc6aDYxk0bdBYTc61KP7KMI6NDFm4o github-deploy'';
in
{
  # Refuse to build with the placeholder, so the machine cannot come up with nobody able to log in.
  assertions = [{
    assertion = !(lib.any (lib.hasInfix "PASTE") sshKeys);
    message = "deploy/server/nixos/configuration.nix: put your SSH public key in sshKeys first.";
  }];

  # Hetzner Cloud boots this machine in a hybrid way: a 1 MiB BIOS boot partition and an EFI partition both exist.
  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/sda" ];
    efiSupport = true;
    efiInstallAsRemovable = true;
  };
  boot.loader.efi.efiSysMountPoint = "/boot";
  boot.initrd.availableKernelModules = [ "ahci" "xhci_pci" "virtio_pci" "virtio_scsi" "sd_mod" "sr_mod" ];

  fileSystems."/" = { device = "/dev/disk/by-label/nixos"; fsType = "ext4"; };
  fileSystems."/boot" = { device = "/dev/disk/by-label/ESP"; fsType = "vfat"; };

  networking.hostName = "mergit";
  networking.useDHCP = true;
  # Docker's published ports skip this firewall (deploy/compose.server.yaml publishes only Caddy's 80 and 443).
  networking.firewall = { enable = true; allowedTCPPorts = [ 22 80 443 ]; };

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  users.users.viscous = {
    isNormalUser = true;
    extraGroups = [ "wheel" "docker" ];
    openssh.authorizedKeys.keys = sshKeys ++ [ deployKey ];
  };
  # There is no password to type; the SSH key is the login.
  security.sudo.wheelNeedsPassword = false;

  virtualisation.docker.enable = true;

  environment.systemPackages = with pkgs; [
    git curl python3 vim
    docker-compose docker-buildx # `docker compose` and `docker build --output` (deploy/server/*.sh)
  ];

  # Where Caddy serves the built sites from (deploy/compose.server.yaml).
  systemd.tmpfiles.rules = [ "d /srv/mergit/sites 0755 viscous users -" ];

  time.timeZone = "UTC";
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  system.stateVersion = "26.05";
}
