// ETHRegistry (PermissionedRegistry) ABI, trimmed to what the ens package calls.
// Source: Sourcify exact-match verified ABI for mainnet 0xf60aba43e1f7f3dab1186ff03b561401c9df85e2 (fetched 2026-11-06).
export const permissionedRegistryAbi = [
  {
    "name": "findExpiry",
    "type": "function",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "findOwner",
    "type": "function",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getExpiry",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getResolver",
    "type": "function",
    "inputs": [
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getState",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "state",
        "type": "tuple",
        "components": [
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum IPermissionedRegistry.Status"
          },
          {
            "name": "expiry",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "latestOwner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "tokenId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "resource",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct IPermissionedRegistry.State"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "getStatus",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "enum IPermissionedRegistry.Status"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "hasRoles",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "roleBitmap",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "latestOwnerOf",
    "type": "function",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "ownerOf",
    "type": "function",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "roles",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "setResolver",
    "type": "function",
    "inputs": [
      {
        "name": "anyId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "resolver",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
] as const;
