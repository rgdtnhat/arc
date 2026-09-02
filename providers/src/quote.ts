import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Hex,
} from "viem";

/** Bind a quote to (provider, price, resource, nonce) so it can't be tampered. */
export function quoteHash(
  provider: Hex,
  price: bigint,
  resource: string,
  nonce: Hex
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "string" },
        { type: "bytes32" },
      ],
      [provider, price, resource, nonce]
    )
  );
}

/** keccak256 commitment to a JSON response body. */
export function responseHash(body: unknown): Hex {
  return keccak256(toHex(JSON.stringify(body)));
}

export function randomNonce(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toHex(bytes);
}
