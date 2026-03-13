import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, Polygon, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ─── Fix: Leaflet's default icon paths break with webpack/Vite bundlers ────────
// This must be done once at module level, not inside a component.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Constants ────────────────────────────────────────────────────────────────

const TRUST_LEVELS = {
  HIGH:    { threshold: 5, color: '#22c55e', label: 'Verified',    bg: '#dcfce7', text: '#15803d' },
  MEDIUM:  { threshold: 1, color: '#eab308', label: 'Vouching',    bg: '#fef9c3', text: '#854d0e' },
  LOW:     { threshold: 0, color: '#ef4444', label: 'Unverified',  bg: '#fee2e2', text: '#b91c1c' },
};

const DEFAULT_CENTER = [12.9716, 77.5946]; // Bengaluru
const DEFAULT_ZOOM   = 13;

// ─── Prop types (runtime guard — install 'prop-types' or use TypeScript instead) ─

/**
 * @typedef {Object} LandEntry
 * @property {string|number}   id             - Unique identifier for the parcel
 * @property {[number,number][]} polygonCoords - Array of [lat, lng] pairs
 * @property {number}          trustScore     - Community vouch count
 * @property {string}          owner          - Ethereum address string
 */

// ─── Helper — resolve trust tier ──────────────────────────────────────────────

/**
 * Returns the full trust tier object for a given score.
 * @param {number} score
 */
function getTrustTier(score) {
  if (score > TRUST_LEVELS.HIGH.threshold)   return TRUST_LEVELS.HIGH;
  if (score >= TRUST_LEVELS.MEDIUM.threshold) return TRUST_LEVELS.MEDIUM;
  return TRUST_LEVELS.LOW;
}

/**
 * Safely truncates an Ethereum address for display.
 * Guards against undefined/null owner values.
 * @param {string} address
 */
function shortAddress(address) {
  if (!address || typeof address !== 'string') return 'Unknown';
  if (address.length < 10) return address;
  return `${address.substring(0, 6)}…${address.substring(address.length - 4)}`;
}

// ─── Sub-component: recenter map when defaultCenter prop changes ──────────────

function MapController({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.setView(center, zoom);
  }, [center, zoom, map]);
  return null;
}

// ─── Sub-component: individual parcel popup ───────────────────────────────────

function ParcelPopup({ land, onVouch, vouchedIds }) {
  const tier      = getTrustTier(land.trustScore);
  const hasVouched = vouchedIds.has(land.id);

  return (
    <Popup>
      <div style={{ minWidth: 180, fontFamily: 'system-ui, sans-serif' }}>

        <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 14 }}>
          Plot #{String(land.id)}
        </p>

        <span style={{
          display:      'inline-block',
          padding:      '2px 8px',
          borderRadius: 12,
          fontSize:     11,
          fontWeight:   600,
          background:   tier.bg,
          color:        tier.text,
          marginBottom: 8,
        }}>
          {tier.label}
        </span>

        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={{ color: '#666', paddingBottom: 2 }}>Trust Score</td>
              <td style={{ fontWeight: 600, textAlign: 'right' }}>{land.trustScore}</td>
            </tr>
            <tr>
              <td style={{ color: '#666' }}>Owner</td>
              <td style={{ fontWeight: 600, textAlign: 'right', fontFamily: 'monospace' }}>
                {shortAddress(land.owner)}
              </td>
            </tr>
          </tbody>
        </table>

        <button
          onClick={() => !hasVouched && onVouch(land.id)}
          disabled={hasVouched}
          style={{
            marginTop:    10,
            width:        '100%',
            padding:      '6px 0',
            borderRadius: 6,
            border:       'none',
            cursor:       hasVouched ? 'not-allowed' : 'pointer',
            background:   hasVouched ? '#e5e7eb' : tier.color,
            color:        hasVouched ? '#9ca3af' : '#fff',
            fontWeight:   600,
            fontSize:     12,
            transition:   'opacity 0.15s',
          }}
        >
          {hasVouched ? '✓ Vouched' : 'Vouch for this plot'}
        </button>
      </div>
    </Popup>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * VatikaMap
 *
 * @param {Object}      props
 * @param {LandEntry[]} props.existingLands   - Array of land parcels to render
 * @param {Function}    [props.onVouch]       - Called with (landId) when user vouches
 * @param {[number,number]} [props.center]    - Map center override
 * @param {number}      [props.zoom]          - Map zoom override
 * @param {string}      [props.height]        - CSS height string, default "500px"
 */
export default function VatikaMap({
  existingLands = [],
  onVouch,
  center = DEFAULT_CENTER,
  zoom   = DEFAULT_ZOOM,
  height = '500px',
}) {
  // Track which parcels the local user has vouched for this session
  const [vouchedIds, setVouchedIds] = useState(new Set());

  const handleVouch = useCallback((landId) => {
    setVouchedIds((prev) => new Set([...prev, landId]));
    if (typeof onVouch === 'function') {
      onVouch(landId);
    } else {
      console.log('[VatikaMap] Vouch for land ID:', landId);
    }
  }, [onVouch]);

  return (
    <div style={{ height, width: '100%', borderRadius: 8, overflow: 'hidden' }}>
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
        // Prevent scroll-hijack on page load
        scrollWheelZoom={false}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />

        {/* Sync map view if center/zoom props change */}
        <MapController center={center} zoom={zoom} />

        {existingLands.map((land) => {
          // Guard: skip parcels with missing or malformed polygon data
          if (!land?.polygonCoords || land.polygonCoords.length < 3) return null;

          const tier = getTrustTier(land.trustScore ?? 0);

          return (
            <Polygon
              key={land.id}
              positions={land.polygonCoords}
              pathOptions={{
                color:       tier.color,
                fillColor:   tier.color,
                fillOpacity: 0.25,
                weight:      2,
              }}
            >
              <ParcelPopup
                land={land}
                onVouch={handleVouch}
                vouchedIds={vouchedIds}
              />
            </Polygon>
          );
        })}
      </MapContainer>
    </div>
  );
}

// ─── Usage example (remove in production) ────────────────────────────────────
//
// const DEMO_LANDS = [
//   {
//     id: 1,
//     polygonCoords: [[12.972, 77.594], [12.974, 77.594], [12.974, 77.597], [12.972, 77.597]],
//     trustScore: 7,
//     owner: '0xAbCd1234EfGh5678IjKl9012MnOp3456QrSt7890',
//   },
//   {
//     id: 2,
//     polygonCoords: [[12.969, 77.591], [12.971, 77.591], [12.971, 77.594], [12.969, 77.594]],
//     trustScore: 2,
//     owner: '0x1111222233334444555566667777888899990000',
//   },
// ];
//
// <VatikaMap existingLands={DEMO_LANDS} onVouch={(id) => console.log('Vouched:', id)} />
