// @circles-sdk/* packages don't work properly as ESM, so we have to revert this script to CommonJS
const { circlesConfig, Sdk } = require('@circles-sdk/sdk');
const { SafeSdkPrivateKeyContractRunner } = require("@circles-sdk/adapter-safe");
const { ethers } = require("ethers");
const { Hub__factory } = require('@circles-sdk/abi-v2');

import type { Address } from "@circles-sdk/utils" with { "resolution-mode": "require" };
import type { BigNumberish } from "ethers" with { "resolution-mode": "require" };
import type { Hub } from '@circles-sdk/abi-v2' with { "resolution-mode": "require" };
import type { SdkContractRunner } from "@circles-sdk/adapter" with { "resolution-mode": "require" };
import type { TokenBalanceRow } from "@circles-sdk/data" with { "resolution-mode": "require" };

const CRC_SAFE_KEY = process.env.CRC_SAFE_KEY;
const CRC_PROFILE: Address = process.env.CRC_PROFILE;
const MAX_RUN_MS: number = parseInt(process.env.MAX_RUN_MS || "0", 10);
const MAX_FLOW_THRESHOLD: number = parseFloat(process.env.MAX_FLOW_THRESHOLD || '1.0');
const API_ENDPOINT = 'https://rpc.aboutcircles.com/';
const RPC_URL = process.env.RPC_URL || 'https://rpc.gnosischain.com/';
let CHAIN_ID = 100; // Gnosis chain

console.log(`running with config:\nchainId=${CHAIN_ID}\nCRC_PROFILE=${CRC_PROFILE}\nMAX_RUN_MS=${MAX_RUN_MS}\nMAX_FLOW_THRESHOLD=${MAX_FLOW_THRESHOLD}\nAPI_ENDPOINT=${API_ENDPOINT}\nRPC_ENDPOINT=${RPC_URL}`);

type PathfinderTransfer = {
  from: Address,
  to: Address,
  tokenOwner: Address,
  value: string // Bignumberish
};

type PathfinderResponse = {
  "maxFlow": string,
  "transfers": PathfinderTransfer[]
};

async function init(crcProfile?: Address, crcSafePrivateKey?: string): Promise<{
  runner: SdkContractRunner,
  hubContract: Hub
}> {
  if (!crcSafePrivateKey || !crcProfile) {
    throw new Error('Missing CRC_SAFE_KEY or CRC_PROFILE environment variables');
  }
  const runner = new SafeSdkPrivateKeyContractRunner(
    crcSafePrivateKey,
    RPC_URL
  );
  await runner.init(crcProfile);
  const hubContract: Hub = Hub__factory.connect(circlesConfig[CHAIN_ID].v2HubAddress, runner);
  return { runner, hubContract }
}

// Helper function to format Wei to ETH
function formatWei(wei: BigNumberish) {
  return ethers.formatUnits(wei, 18);
}

// Helper function to parse ETH to Wei
function parseEth(eth: BigNumberish) {
  return ethers.parseUnits(eth.toString(), 18);
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Find path function
async function findPath(amount?: bigint, targetAddress?: Address, currentAddress?: Address): Promise<PathfinderResponse> {
  if (!currentAddress) {
    throw new Error('No connected wallet found');
  }

  const params = {
    Source: currentAddress,
    Sink: targetAddress ?? currentAddress, // Send transfer to self
    TargetFlow: (amount ?? parseEth("100000000000")).toString(), // Use a large number for max flow check
    WithWrap: false,
    ToTokens: [currentAddress], // Specify connected address as return token
  };

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "circlesV2_findPath",
      params: [params],
    }),
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message);
  }
  console.log("Pathfinder response:", JSON.stringify(data.result, null, 2));
  return data.result;
}

/**
 * Build the four arguments expected by Hub.operateFlowMatrix()
 * from a Pathfinder result.
 *
 * @param {object}   pathData  – result of circlesV2_findPath
 * @param {string}   from      – source avatar (connected wallet)
 * @param {string}   to        – sink avatar (usually = from)
 * @param {string}   value     – target flow (dec / hex string)
 *
 * @returns {{
 *   _flowVertices: string[],
 *   _flow:        { streamSinkId: number, amount: string|bigint }[],
 *   _streams:     { sourceCoordinate: number, flowEdgeIds: number[], data: Uint8Array }[],
 *   _packedCoordinates: Uint8Array,
 *   sourceCoordinate: number
 * }}
 */
function generateFlowMatrixParams(pathData: PathfinderResponse, from: Address, to: Address, value: BigNumberish): {
  _flowVertices: string[];
  _flow: { streamSinkId: number; amount: string | bigint; }[];
  _streams: { sourceCoordinate: number; flowEdgeIds: number[]; data: Uint8Array; }[];
  _packedCoordinates: Uint8Array;
  sourceCoordinate: number;
} {
  // ────── guards ───────────────────────────────────────────────────────
  if (!pathData || !Array.isArray(pathData.transfers) || !pathData.transfers.length)
    throw new Error('Pathfinder returned no transfers');

  from = from.toLowerCase();
  to = to.toLowerCase();

  const expectedValue = BigInt(value);

  // ────── 1. normalise transfers + collect all addresses ───────────────
  const addrs = new Set([from, to]);
  const transfers = pathData.transfers.map(t => {
    const norm = {
      from: t.from.toLowerCase(),
      to: t.to.toLowerCase(),
      tokenOwner: t.tokenOwner.toLowerCase(),
      value: t.value                 // string
    };
    addrs.add(norm.from);
    addrs.add(norm.to);
    addrs.add(norm.tokenOwner);
    return norm;
  });

  // ────── 2. strictly-ascending vertices (numeric compare) ─────────────
  const flowVertices = [...addrs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

  // lookup[address] → coordinate
  const lookUpMap: Record<Address, number> = {};
  flowVertices.forEach((addr, idx) => (lookUpMap[addr] = idx));

  // ────── 3. flow edges, mark edges that reach the sink ────────────────
  const flowEdges = transfers.map(t => ({
    streamSinkId: (t.to === to) ? 1 : 0,      // only edges that end in 'to' get 1
    amount: BigInt(t.value)             // uint192 fits in JS BigInt
  }));

  // ensure *at least* one edge is terminal
  if (!flowEdges.some(e => e.streamSinkId === 1)) {
    const lastIdx = transfers.map(t => t.to).lastIndexOf(to);
    (lastIdx >= 0 ? flowEdges[lastIdx] : flowEdges[flowEdges.length - 1]).streamSinkId = 1;
  }

  // verify sum( terminal amounts ) == value requested
  const terminalSum = flowEdges
    .filter(e => e.streamSinkId === 1)
    .reduce((s, e) => s + e.amount, 0n);

  if (terminalSum !== expectedValue)
    throw new Error(`terminal amount ${terminalSum} ≠ requested ${expectedValue}`);

  // ────── 4. one Stream referencing all terminal edges ─────────────────
  const flowEdgeIds = flowEdges
    .map((e, idx) => (e.streamSinkId === 1 ? idx : -1))
    .filter(idx => idx !== -1);

  const stream = {
    sourceCoordinate: lookUpMap[from],
    flowEdgeIds: flowEdgeIds,
    data: new Uint8Array()        // no user-data
  };

  // ────── 5. coordinate triples (tokenId, src, dst) ────────────────────
  const coords: number[] = [];
  transfers.forEach(t => {
    coords.push(
      lookUpMap[t.tokenOwner],
      lookUpMap[t.from],
      lookUpMap[t.to]
    );
  });

  // pack uint16[] → Uint8Array big-endian
  const packed = new Uint8Array(coords.length * 2);
  coords.forEach((c, i) => {
    packed[2 * i] = c >> 8;
    packed[2 * i + 1] = c & 0xff;
  });

  // ────── 6. return exactly what operateFlowMatrix expects ─────────────
  return {
    _flowVertices: flowVertices,
    _flow: flowEdges,
    _streams: [stream],
    _packedCoordinates: packed,
    sourceCoordinate: lookUpMap[from]      // optional convenience
  };
}

async function tryReplenish(hubContract: Hub, thresholdCRC?: number, currentAddress?: Address) {
  console.log('Checking max flow to self...');
  const pathData = await findPath(undefined, currentAddress, currentAddress);
  let maxFlow = BigInt(pathData?.maxFlow ?? "0");
  const maxFlowCRC = formatWei(maxFlow);
  const maxFlowThreshold = parseEth(thresholdCRC ?? "1.0");

  if (maxFlow >= maxFlowThreshold && pathData.transfers.length) {
    console.log(`Max flow available: ${maxFlow} WEI (${maxFlowCRC} CRC)`);
    const amount: bigint = parseEth(maxFlowCRC);
    console.log(`Generating flow params for ${amount} WEI (${formatWei(amount)} CRC) to self (${currentAddress})`);
    const params = generateFlowMatrixParams(pathData, currentAddress, currentAddress, amount.toString());

    console.log('Sending operateFlowMatrix transaction...');

    const tx = await hubContract.operateFlowMatrix(
      params._flowVertices,
      params._flow,
      params._streams,
      params._packedCoordinates,
    );
    console.log('Transaction sent, waiting for confirmation...', tx?.hash);
    const receipt = await tx?.wait();
    console.log('Transaction confirmed:', receipt?.hash);
    console.log(`View on explorer: https://gnosisscan.io/tx/${receipt?.hash}`);
    return amount;
  } else {
    console.log(`Max flow ${maxFlowCRC} CRC is below threshold of ${formatWei(maxFlowThreshold)} CRC, not sending transaction.`);
  }
}

/**
 * Wraps the personal tokens into static CRC
 * @param runner - used to send the transactions
 * @param amount - optional amount to wrap
 */
async function wrapSelfBalance(runner: SdkContractRunner, amount?: bigint) {
  console.log('Checking self balance to wrap...');
  const sdk = new Sdk(runner, circlesConfig[CHAIN_ID]);
  const avatar = await sdk.getAvatar(CRC_PROFILE, false)
  const balances: TokenBalanceRow[] = await avatar.getBalances()
  const selfBalance: TokenBalanceRow = balances.find(b => b.tokenAddress.toLowerCase() === avatar.address.toLowerCase());
  if (selfBalance) {
    const amountToWrap = amount ?? BigInt(selfBalance.attoCircles);
    if (BigInt(selfBalance.attoCircles) > 0n && BigInt(selfBalance.attoCircles) >= amountToWrap) {
      console.log(`Wrapping ${formatWei(amountToWrap)} CRC (${amountToWrap} WEI) into static CRC...`);
      await avatar.wrapInflationErc20(avatar.address, amountToWrap);
      console.log('done wrapping');
    } else {
      console.log('Nothing to wrap, self balance is zero or below the specified amount to wrap.');
    }
  } else {
    console.log('Nothing to wrap, self balance is zero or not found.');
  }
}

const start = Date.now();

async function mainLoop(maxRunMs: number = 0) {
  const { runner, hubContract } = await init(CRC_PROFILE, CRC_SAFE_KEY);
  while (maxRunMs == 0 || (Date.now() - start <= maxRunMs)) {
    try {
      const amount = await tryReplenish(hubContract, MAX_FLOW_THRESHOLD, CRC_PROFILE);
      await wrapSelfBalance(runner, amount);
      await sleep(30 * 1000); // Wait 30 seconds before the next check
    } catch (error) {
      console.error('Error in main loop:', error);
    }
  }
}

mainLoop(MAX_RUN_MS)
  .finally(() => {
    console.log(`Finished main loop after ${Date.now() - start} milliseconds...`);
  })
