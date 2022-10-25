import * as fs from 'fs';
import * as path from 'path';
import * as chalk from 'chalk';
import * as cliProgress from 'cli-progress';
require("dotenv").config();
import { api, connection } from '@sora-substrate/util';
import { xxhashAsHex } from '@polkadot/util-crypto';
import { execFileSync, execSync } from 'child_process';
import * as codec from '@polkadot/types/codec';
import * as runtime from '@polkadot/types/interfaces/runtime';
import * as primitive from '@polkadot/types/primitive';
const binaryPath = path.join(__dirname, 'data', 'binary');
const wasmPath = path.join(__dirname, 'data', 'runtime.wasm');
const schemaPath = path.join(__dirname, 'data', 'schema.json');
const hexPath = path.join(__dirname, 'data', 'runtime.hex');
const originalSpecPath = path.join(__dirname, 'data', 'genesis.json');
const forkedSpecPath = path.join(__dirname, 'data', 'fork.json');
const storagePath = path.join(__dirname, 'data', 'storage.json');
const keysPath = path.join(__dirname, 'data', 'keys.json');

const ENDPOINT = 'wss://ws.framenode-1.v1.tst.sora2.soramitsu.co.jp';
// Using http endpoint since substrate's Ws endpoint has a size limit.
const HTTP_ENDPOINT = process.env.HTTP_RPC_ENDPOINT || ENDPOINT;
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = +(process.env.FORK_CHUNKS_LEVEL || 1);
const totalChunks = Math.pow(256, chunksLevel);

const alice = process.env.ALICE || ''
const originalChain = process.env.ORIG_CHAIN || '';
const forkChain = process.env.FORK_CHAIN || '';

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];
const skippedModulesPrefix = ['System', 'Session', 'Babe', 'Grandpa', 'GrandpaFinality', 'FinalityTracker', 'Authorship'];

async function fixParachinStates(api, forkedSpec) {
  const skippedKeys = [
    api.query.parasScheduler.sessionStartBlock.key()
  ];
  for (const k of skippedKeys) {
    delete forkedSpec.genesis.raw.top[k];
  }
}

class KeysFile {
  at: string;
  keys: string[];
}

async function main() {
  await connection.open(HTTP_ENDPOINT);
  api.initialize();
  console.log('Connected to:', HTTP_ENDPOINT);
  if (!fs.existsSync(binaryPath)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', binaryPath]);

  if (!fs.existsSync(wasmPath)) {
    console.log(chalk.red('WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'));
    process.exit(1);
  }
  execSync('cat ' + wasmPath + ' | hexdump -ve \'/1 "%02x"\' > ' + hexPath);

  const metadata = await api.apiRx.rpc.state.getMetadata().toPromise();
  // Populate the prefixes array
  let modulePrefixes: string[] = [];
  const modules = metadata.asV14.pallets;
  modules.forEach((module) => {
    if (module.storage) {
      modulePrefixes.push(xxhashAsHex(module.name.toString(), 128));
      if (!skippedModulesPrefix.includes(module.name.toString())) {
        prefixes.push(xxhashAsHex(module.name.toString(), 128));
      }
    }
  });

  if (fs.existsSync(keysPath)) {
    console.log(chalk.yellow('Reusing cached keys. Delete ./data/keys.json and rerun the script if you want to fetch latest keys'));
  } else {
    let at = (await api.apiRx.rpc.chain.getBlockHash().toPromise()).toString();
    const keys = await fetchKeys("0x", at);
    fs.writeFileSync(keysPath, JSON.stringify({ keys, at }, null, 2));
  }
  let { keys, at }: KeysFile = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  console.log("Loaded keys: ", keys.length);

  if (fs.existsSync(storagePath)) {
    let storage = new Set();
    fs.readFileSync(storagePath, 'utf8').split('\n').forEach((line) => {
      if (line.length > 0) {
        storage.add(JSON.parse(line)[0]);
      }
    });

    keys = keys.filter((key) => !storage.has(key));
  }

  console.log("Remaining keys: ", keys.length);

  if (keys.length > 0) {
    // Download state of original chain
    console.log(chalk.green('Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.'));
    progressBar.start(keys.length, 0);
    const stream = fs.createWriteStream(storagePath, { flags: 'a' });
    await fetchChunks(keys, stream, at);
    stream.end();
    progressBar.stop();
  }

  // Generate chain spec for original and forked chains
  // if (originalChain == '') {
  //   execSync(binaryPath + ` build-spec --raw > ` + originalSpecPath);
  // } else {
  //   execSync(binaryPath + ` build-spec --chain ${originalChain} --raw > ` + originalSpecPath);
  // }
  if (forkChain == '') {
    execSync(binaryPath + ` build-spec --chain local --raw > ` + forkedSpecPath);
  } else {
    execSync(binaryPath + ` build-spec --chain ${forkChain} --raw > ` + forkedSpecPath);
  }

  let storage = [];
  {
    fs.readFileSync(storagePath, 'utf8').split('\n').forEach((line) => {
      if (line.length > 0) {
        storage.push(JSON.parse(line));
      }
    });
  }
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, 'utf8'));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, 'utf8'));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + '-fork';
  forkedSpec.id = originalSpec.id + '-fork';
  forkedSpec.protocolId = originalSpec.protocolId;

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  // fixParachinStates(api, forkedSpec);

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top['0x3a636f6465'] = '0x' + fs.readFileSync(hexPath, 'utf8').trim();

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  forkedSpec.genesis.raw.top['0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b'] = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log('Forked genesis generated successfully. Find it at ./data/fork.json');
  process.exit();
}

main();

async function fetchChunks(keys: string[], stream, at) {
  let batchSize = 100;
  for (let i = 0; i < keys.length; i+=batchSize) {
    const batch = keys.slice(i, Math.min(i + batchSize, keys.length - 1));
    const values = await api.apiRx.rpc.state.queryStorageAt(batch, at).toPromise() as codec.Option<runtime.StorageData>;
    for (let j = 0; j < batch.length; j++) {
      stream.write(JSON.stringify([batch[j], values[j].toString()]) + '\n');
    }
    chunksFetched += batchSize;
    progressBar.update(chunksFetched);
  }
  return;
}

async function fetchKeys(prefix: string, at): Promise<primitive.StorageKey[]> {
  let keys = [];
  let startKey;
  while (true) {
    let new_keys = (await api.apiRx.rpc.state.getKeysPaged(prefix, 1000, startKey, at).toPromise()).toArray();
    if (new_keys.length == 0) {
      break;
    }
    startKey = new_keys[new_keys.length - 1];
    keys.push(...new_keys);
    console.log(`Fetched ${new_keys.length} keys, total: ${keys.length}`);
  }
  return keys;
}