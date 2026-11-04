// ERC-20 transfer(address,uint256), followed by a versioned 32-byte tag and
// an unpredictable 32-byte order reference. Only explicitly enabled tokens use it.
export const PAYMENT_REFERENCE_MAGIC = Buffer.from('AVENORA_PAY_REF_V1').toString('hex').padEnd(64, '0');
export const isPaymentReference = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);

export function encodeReferenceTransfer({ recipient, amountAtomic, reference }) {
  if (!/^0x[0-9a-f]{40}$/i.test(recipient || '') || !isPaymentReference(reference) || !/^[1-9]\d*$/.test(String(amountAtomic)))
    throw new Error('Invalid reference payment');
  const amount = BigInt(amountAtomic);
  if (amount >= 2n ** 256n) throw new Error('Reference amount exceeds uint256');
  return '0xa9059cbb' + recipient.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0') + PAYMENT_REFERENCE_MAGIC + reference.slice(2).toLowerCase();
}

export function decodeReferenceTransfer(data) {
  if (typeof data !== 'string' || !/^0xa9059cbb[0-9a-f]{256}$/i.test(data)) return null;
  const input = data.toLowerCase();
  if (input.slice(10, 34) !== '0'.repeat(24) || input.slice(138, 202) !== PAYMENT_REFERENCE_MAGIC) return null;
  const reference = '0x' + input.slice(202);
  const amount = BigInt('0x' + input.slice(74, 138));
  if (!isPaymentReference(reference) || amount === 0n) return null;
  return { recipient:'0x' + input.slice(34, 74), amount_atomic:amount.toString(), reference };
}

export function referenceMethod(store, chain, tokenId, mode) {
  const network = store.registry.find(c => c.id === chain);
  const token = network?.tokens.find(t => t.id === tokenId);
  if (!network || network.family !== 'evm' || token?.kind !== 'token' || !Number.isSafeInteger(network.chainId)) return null;
  if (mode === 'demo') return chain === 'bsc' && tokenId === 'bsc-usdt' ? { chainId:56, contract:null } : null;
  try {
    if (!store.configured(chain, tokenId)) return null;
    const config = store.chainConfig(chain);
    const configured = store.configuredTokens?.(chain, config);
    const entry = configured?.find(t => t.id === tokenId);
    if (entry?.paymentReference !== true || !/^0x[0-9a-f]{40}$/i.test(entry.contract || '')) return null;
    return { chainId:network.chainId, contract:entry.contract.toLowerCase() };
  } catch { return null; }
}
