// pinataUpload.js
// Uploads a land deed file + metadata to IPFS via Pinata REST API
// Returns the IPFS CID to pass into VatikaRegistry.registerLand()

require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
// Store keys in a .env file — NEVER hardcode them
// .env contents:
//   PINATA_API_KEY=your_key_here
//   PINATA_SECRET_API_KEY=your_secret_here

const PINATA_API_KEY    = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_SECRET_API_KEY;
const PINATA_PIN_URL    = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_JSON_URL   = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

// ─── Validate env vars on startup ────────────────────────────────────────────
if (!PINATA_API_KEY || !PINATA_API_SECRET) {
  throw new Error(
    'Missing Pinata credentials. Add PINATA_API_KEY and PINATA_SECRET_API_KEY to your .env file.'
  );
}

// ─── Shared Axios headers ─────────────────────────────────────────────────────
const authHeaders = {
  pinata_api_key:        PINATA_API_KEY,
  pinata_secret_api_key: PINATA_API_SECRET,
};

/**
 * Upload a land deed file to IPFS via Pinata.
 *
 * @param {string} filePath     - Absolute or relative path to the file on disk
 * @param {Object} landDetails  - Metadata about the parcel
 * @param {string} landDetails.id       - Unique land ID / token ID
 * @param {string} landDetails.coords   - GeoJSON or "lat,lng" string
 * @param {number} [landDetails.trustScore=0] - Initial trust score
 * @returns {Promise<string>}   - IPFS CID (pass to registerLand() as _uri)
 */
async function pinFileToIPFS(filePath, landDetails) {
  if (!filePath || !landDetails?.id || !landDetails?.coords) {
    throw new Error('pinFileToIPFS: filePath, landDetails.id and landDetails.coords are required');
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(resolvedPath));

  const pinataMetadata = JSON.stringify({
    name: `Land_Deed_${landDetails.id}`,
    keyvalues: {
      coords:     String(landDetails.coords),
      trustScore: String(landDetails.trustScore ?? 0),
      landId:     String(landDetails.id),
    },
  });
  form.append('pinataMetadata', pinataMetadata);

  const pinataOptions = JSON.stringify({ cidVersion: 1 });
  form.append('pinataOptions', pinataOptions);

  const res = await axios.post(PINATA_PIN_URL, form, {
    // form.getHeaders() supplies the correct multipart boundary —
    // omitting this causes a 400 "invalid form data" error from Pinata
    headers: {
      ...form.getHeaders(),
      ...authHeaders,
    },
    maxBodyLength: Infinity,  // Required for large files; axios default is 10mb
    maxContentLength: Infinity,
  });

  const cid = res.data?.IpfsHash;
  if (!cid) throw new Error('Pinata did not return an IpfsHash');

  return cid;
}

/**
 * Upload a JSON metadata object to IPFS via Pinata.
 * Use this for the token URI — most NFT standards expect a JSON metadata URI.
 *
 * @param {Object} landDetails
 * @param {string} landDetails.id
 * @param {string} landDetails.coords
 * @param {string} landDetails.deedCid  - CID of the deed file (from pinFileToIPFS)
 * @returns {Promise<string>}            - IPFS URI string: "ipfs://<CID>"
 */
async function pinMetadataToIPFS(landDetails) {
  if (!landDetails?.id || !landDetails?.coords) {
    throw new Error('pinMetadataToIPFS: landDetails.id and landDetails.coords are required');
  }

  // ERC-721 standard metadata schema
  const metadata = {
    name:        `Vatika Land Parcel #${landDetails.id}`,
    description: 'A registered land parcel on the Vatika blockchain registry.',
    image:       landDetails.deedCid ? `ipfs://${landDetails.deedCid}` : '',
    attributes: [
      { trait_type: 'Coordinates',  value: landDetails.coords },
      { trait_type: 'Trust Score',  value: 0 },
      { trait_type: 'Land ID',      value: String(landDetails.id) },
    ],
  };

  const body = {
    pinataContent:  metadata,
    pinataMetadata: { name: `Land_Metadata_${landDetails.id}` },
    pinataOptions:  { cidVersion: 1 },
  };

  const res = await axios.post(PINATA_JSON_URL, body, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
  });

  const cid = res.data?.IpfsHash;
  if (!cid) throw new Error('Pinata did not return an IpfsHash for metadata');

  return `ipfs://${cid}`;
}

/**
 * Full pipeline: upload deed file → upload metadata JSON → return token URI.
 * Pass the returned URI directly to VatikaRegistry.registerLand().
 *
 * @param {string} filePath
 * @param {Object} landDetails  - { id, coords }
 * @returns {Promise<{ deedCid: string, tokenURI: string }>}
 */
async function uploadLandToIPFS(filePath, landDetails) {
  console.log(`[Pinata] Uploading deed file for land #${landDetails.id}...`);
  const deedCid = await pinFileToIPFS(filePath, landDetails);
  console.log(`[Pinata] Deed CID: ${deedCid}`);

  console.log(`[Pinata] Uploading metadata JSON...`);
  const tokenURI = await pinMetadataToIPFS({ ...landDetails, deedCid });
  console.log(`[Pinata] Token URI: ${tokenURI}`);

  return { deedCid, tokenURI };
}

module.exports = { pinFileToIPFS, pinMetadataToIPFS, uploadLandToIPFS };

// ─── Usage example ────────────────────────────────────────────────────────────
// const { uploadLandToIPFS } = require('./pinataUpload');
//
// const { tokenURI } = await uploadLandToIPFS('./deed.pdf', {
//   id: '1',
//   coords: '12.9716,77.5946',
// });
//
// await vatikaContract.registerLand('12.9716,77.5946', tokenURI);
