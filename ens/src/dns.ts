import { toHex, type Hex } from "viem";
import { packetToBytes } from "viem/ens";

/** DNS wire-format name, as the PermissionedResolver's `name` arguments expect. */
export const dnsName = (name: string): Hex => toHex(packetToBytes(name));
