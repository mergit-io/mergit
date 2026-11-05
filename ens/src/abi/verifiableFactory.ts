// VerifiableFactory ABI, trimmed to what the ens package calls.
// Source: Sourcify exact-match verified ABI for mainnet 0x77510ba162dfea3d8989e3f0928a691b345730d2 (fetched 2026-11-06).
export const verifiableFactoryAbi = [
  {
    "type": "constructor",
    "inputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "VerificationFailed",
    "type": "error",
    "inputs": [
      {
        "name": "proxy",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "ProxyDeployed",
    "type": "event",
    "inputs": [
      {
        "name": "sender",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "proxyAddress",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "implementation",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "deployProxy",
    "type": "function",
    "inputs": [
      {
        "name": "implementation",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "proxy",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "name": "predictProxyAddress",
    "type": "function",
    "inputs": [
      {
        "name": "deployer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "salt",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "proxy",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "proxyLogic",
    "type": "function",
    "inputs": [],
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
    "name": "verifyContract",
    "type": "function",
    "inputs": [
      {
        "name": "proxy",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "implementation",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  }
] as const;
