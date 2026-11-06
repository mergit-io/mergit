// PermissionedResolver (deployed implementation) ABI, trimmed to what the ens package calls.
// Source: Sourcify exact-match verified ABI for mainnet 0x565b0f456a04ac9b48758190e90030623cff57c5 (fetched 2026-11-06).
export const permissionedResolverAbi = [
  {
    "name": "AddressEmptyCode",
    "type": "error",
    "inputs": [
      {
        "name": "target",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "DNSDecodingFailed",
    "type": "error",
    "inputs": [
      {
        "name": "dns",
        "type": "bytes",
        "internalType": "bytes"
      }
    ]
  },
  {
    "name": "EACCannotGrantRoles",
    "type": "error",
    "inputs": [
      {
        "name": "resource",
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
    ]
  },
  {
    "name": "EACCannotRevokeRoles",
    "type": "error",
    "inputs": [
      {
        "name": "resource",
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
    ]
  },
  {
    "name": "EACInvalidAccount",
    "type": "error",
    "inputs": []
  },
  {
    "name": "EACInvalidRoleBitmap",
    "type": "error",
    "inputs": [
      {
        "name": "roleBitmap",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "EACMaxAssignees",
    "type": "error",
    "inputs": [
      {
        "name": "resource",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "role",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "EACMinAssignees",
    "type": "error",
    "inputs": [
      {
        "name": "resource",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "role",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "EACRootResourceNotAllowed",
    "type": "error",
    "inputs": []
  },
  {
    "name": "EACUnauthorizedAccountRoles",
    "type": "error",
    "inputs": [
      {
        "name": "resource",
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
    ]
  },
  {
    "name": "ERC1967InvalidImplementation",
    "type": "error",
    "inputs": [
      {
        "name": "implementation",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "ERC1967NonPayable",
    "type": "error",
    "inputs": []
  },
  {
    "name": "FailedCall",
    "type": "error",
    "inputs": []
  },
  {
    "name": "InvalidContentType",
    "type": "error",
    "inputs": [
      {
        "name": "contentType",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "InvalidEVMAddress",
    "type": "error",
    "inputs": [
      {
        "name": "addressBytes",
        "type": "bytes",
        "internalType": "bytes"
      }
    ]
  },
  {
    "name": "InvalidInitialization",
    "type": "error",
    "inputs": []
  },
  {
    "name": "InvalidRecord",
    "type": "error",
    "inputs": []
  },
  {
    "name": "NotInitializing",
    "type": "error",
    "inputs": []
  },
  {
    "name": "UUPSUnauthorizedCallContext",
    "type": "error",
    "inputs": []
  },
  {
    "name": "UUPSUnsupportedProxiableUUID",
    "type": "error",
    "inputs": [
      {
        "name": "slot",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "name": "UnsupportedResolverProfile",
    "type": "error",
    "inputs": [
      {
        "name": "selector",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ]
  },
  {
    "name": "EACRolesChanged",
    "type": "event",
    "inputs": [
      {
        "name": "resource",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "account",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldRoleBitmap",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newRoleBitmap",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "name": "Linked",
    "type": "event",
    "inputs": [
      {
        "name": "recordId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "node",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "name",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ResourceArgument",
    "type": "event",
    "inputs": [
      {
        "name": "resource",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "arg",
        "type": "bytes",
        "indexed": false,
        "internalType": "bytes"
      }
    ],
    "anonymous": false
  },
  {
    "name": "TextUpdated",
    "type": "event",
    "inputs": [
      {
        "name": "recordId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "keyHash",
        "type": "string",
        "indexed": true,
        "internalType": "string"
      },
      {
        "name": "key",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "value",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "name": "ROOT_RESOURCE",
    "type": "function",
    "inputs": [],
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
    "name": "decodeSetter",
    "type": "function",
    "inputs": [
      {
        "name": "setter",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "arg",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "resource",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "roleBitmap",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "name": "getRecordId",
    "type": "function",
    "inputs": [
      {
        "name": "node",
        "type": "bytes32",
        "internalType": "bytes32"
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
    "name": "grantRoles",
    "type": "function",
    "inputs": [
      {
        "name": "resource",
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
    "stateMutability": "pure"
  },
  {
    "name": "grantRootRoles",
    "type": "function",
    "inputs": [
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
    "stateMutability": "nonpayable"
  },
  {
    "name": "grantSetterRoles",
    "type": "function",
    "inputs": [
      {
        "name": "setter",
        "type": "bytes",
        "internalType": "bytes"
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
    "stateMutability": "nonpayable"
  },
  {
    "name": "hasRoles",
    "type": "function",
    "inputs": [
      {
        "name": "resource",
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
    "name": "hasRootRoles",
    "type": "function",
    "inputs": [
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
    "name": "initialize",
    "type": "function",
    "inputs": [
      {
        "name": "grants",
        "type": "tuple[]",
        "components": [
          {
            "name": "account",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "roleBitmap",
            "type": "uint256",
            "internalType": "uint256"
          }
        ],
        "internalType": "struct Grant[]"
      },
      {
        "name": "calls",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "linkToNode",
    "type": "function",
    "inputs": [
      {
        "name": "sourceName",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "targetNode",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "linkToRecord",
    "type": "function",
    "inputs": [
      {
        "name": "sourceName",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "recordId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "multicall",
    "type": "function",
    "inputs": [
      {
        "name": "calls",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [
      {
        "name": "results",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "name": "resolve",
    "type": "function",
    "inputs": [
      {
        "name": "name",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "revokeRoles",
    "type": "function",
    "inputs": [
      {
        "name": "resource",
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
    "stateMutability": "nonpayable"
  },
  {
    "name": "revokeRootRoles",
    "type": "function",
    "inputs": [
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
    "stateMutability": "nonpayable"
  },
  {
    "name": "roles",
    "type": "function",
    "inputs": [
      {
        "name": "resource",
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
    "name": "setAddress",
    "type": "function",
    "inputs": [
      {
        "name": "name",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "coinType",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "addressBytes",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "setText",
    "type": "function",
    "inputs": [
      {
        "name": "name",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "key",
        "type": "string",
        "internalType": "string"
      },
      {
        "name": "value",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  }
] as const;
