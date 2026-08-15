// Country → time zone, and coordinates → country.
//
// WHY THIS EXISTS: every timestamp the upstream API returns is UTC. Showing a
// client "removed at 03:40" when their working day says 09:10 is not a display
// nicety, it is a wrong answer to "when did this happen?". So the portal keeps
// one preference — which country's clock to read the data in — and every
// timestamp is rendered through it (see lib/timezone.tsx).
//
// Country is the FRIENDLY handle; the IANA zone is what actually does the work,
// because a zone carries its own daylight-saving history and a country does
// not. Which is also why the browser's own zone is the default: it is exact,
// needs no permission, and already knows whether today is BST or GMT.
//
// The geographic half of this file is generated (lib/countryBounds.ts); the
// zones below are chosen by hand, because a country with several zones has no
// single right answer and picking one is an editorial decision, not data.

import { COUNTRY_BOUNDS, type CountryBounds } from './countryBounds'
import { ISO_TO_COUNTRY } from './isoCountries'

/**
 * Representative IANA zone per country.
 *
 * Names are Natural Earth's, so they line up with COUNTRY_BOUNDS and with the
 * country column the warehouse reports on.
 *
 * Countries marked MULTI span more than one zone and the entry is the one
 * covering the largest population — a US client is shown New York time unless
 * they pick otherwise. Their own browser zone still wins when it is set, so
 * this only decides what "United States of America" means when someone selects
 * it by hand from another country.
 */
export const COUNTRY_ZONES: Record<string, string> = {
  // ── Asia ────────────────────────────────────────────────────────────────
  'India': 'Asia/Kolkata',
  'Pakistan': 'Asia/Karachi',
  'Bangladesh': 'Asia/Dhaka',
  'Sri Lanka': 'Asia/Colombo',
  'Nepal': 'Asia/Kathmandu',
  'Bhutan': 'Asia/Thimphu',
  'Afghanistan': 'Asia/Kabul',
  'China': 'Asia/Shanghai',
  'Taiwan': 'Asia/Taipei',
  'Japan': 'Asia/Tokyo',
  'South Korea': 'Asia/Seoul',
  'North Korea': 'Asia/Pyongyang',
  'Mongolia': 'Asia/Ulaanbaatar',
  'Vietnam': 'Asia/Ho_Chi_Minh',
  'Thailand': 'Asia/Bangkok',
  'Cambodia': 'Asia/Phnom_Penh',
  'Laos': 'Asia/Vientiane',
  'Myanmar': 'Asia/Yangon',
  'Malaysia': 'Asia/Kuala_Lumpur',
  'Singapore': 'Asia/Singapore',
  'Brunei': 'Asia/Brunei',
  'Indonesia': 'Asia/Jakarta',              // MULTI — Java/Sumatra
  'Philippines': 'Asia/Manila',
  'Timor-Leste': 'Asia/Dili',
  'Kazakhstan': 'Asia/Almaty',              // MULTI
  'Uzbekistan': 'Asia/Tashkent',
  'Turkmenistan': 'Asia/Ashgabat',
  'Kyrgyzstan': 'Asia/Bishkek',
  'Tajikistan': 'Asia/Dushanbe',
  // ── Middle East ─────────────────────────────────────────────────────────
  'Turkey': 'Europe/Istanbul',
  'Israel': 'Asia/Jerusalem',
  'Palestine': 'Asia/Hebron',
  'Lebanon': 'Asia/Beirut',
  'Syria': 'Asia/Damascus',
  'Jordan': 'Asia/Amman',
  'Iraq': 'Asia/Baghdad',
  'Iran': 'Asia/Tehran',
  'Saudi Arabia': 'Asia/Riyadh',
  'United Arab Emirates': 'Asia/Dubai',
  'Qatar': 'Asia/Qatar',
  'Kuwait': 'Asia/Kuwait',
  'Bahrain': 'Asia/Bahrain',
  'Oman': 'Asia/Muscat',
  'Yemen': 'Asia/Aden',
  'Armenia': 'Asia/Yerevan',
  'Azerbaijan': 'Asia/Baku',
  'Georgia': 'Asia/Tbilisi',
  'Cyprus': 'Asia/Nicosia',
  // ── Europe ──────────────────────────────────────────────────────────────
  'United Kingdom': 'Europe/London',
  'Ireland': 'Europe/Dublin',
  'Portugal': 'Europe/Lisbon',
  'Spain': 'Europe/Madrid',
  'France': 'Europe/Paris',
  'Belgium': 'Europe/Brussels',
  'Netherlands': 'Europe/Amsterdam',
  'Luxembourg': 'Europe/Luxembourg',
  'Germany': 'Europe/Berlin',
  'Switzerland': 'Europe/Zurich',
  'Austria': 'Europe/Vienna',
  'Italy': 'Europe/Rome',
  'Malta': 'Europe/Malta',
  'Denmark': 'Europe/Copenhagen',
  'Norway': 'Europe/Oslo',
  'Sweden': 'Europe/Stockholm',
  'Finland': 'Europe/Helsinki',
  'Iceland': 'Atlantic/Reykjavik',
  'Estonia': 'Europe/Tallinn',
  'Latvia': 'Europe/Riga',
  'Lithuania': 'Europe/Vilnius',
  'Poland': 'Europe/Warsaw',
  'Czechia': 'Europe/Prague',
  'Slovakia': 'Europe/Bratislava',
  'Hungary': 'Europe/Budapest',
  'Slovenia': 'Europe/Ljubljana',
  'Croatia': 'Europe/Zagreb',
  'Bosnia and Herz.': 'Europe/Sarajevo',
  'Serbia': 'Europe/Belgrade',
  'Montenegro': 'Europe/Podgorica',
  'Kosovo': 'Europe/Belgrade',
  'Macedonia': 'Europe/Skopje',
  'Albania': 'Europe/Tirane',
  'Greece': 'Europe/Athens',
  'Bulgaria': 'Europe/Sofia',
  'Romania': 'Europe/Bucharest',
  'Moldova': 'Europe/Chisinau',
  'Ukraine': 'Europe/Kyiv',
  'Belarus': 'Europe/Minsk',
  'Russia': 'Europe/Moscow',                // MULTI — eleven zones
  // ── Africa ──────────────────────────────────────────────────────────────
  'Morocco': 'Africa/Casablanca',
  'Algeria': 'Africa/Algiers',
  'Tunisia': 'Africa/Tunis',
  'Libya': 'Africa/Tripoli',
  'Egypt': 'Africa/Cairo',
  'Sudan': 'Africa/Khartoum',
  'S. Sudan': 'Africa/Juba',
  'Ethiopia': 'Africa/Addis_Ababa',
  'Eritrea': 'Africa/Asmara',
  'Djibouti': 'Africa/Djibouti',
  'Somalia': 'Africa/Mogadishu',
  'Kenya': 'Africa/Nairobi',
  'Uganda': 'Africa/Kampala',
  'Tanzania': 'Africa/Dar_es_Salaam',
  'Rwanda': 'Africa/Kigali',
  'Burundi': 'Africa/Bujumbura',
  'Nigeria': 'Africa/Lagos',
  'Ghana': 'Africa/Accra',
  "Côte d'Ivoire": 'Africa/Abidjan',
  'Senegal': 'Africa/Dakar',
  'Mali': 'Africa/Bamako',
  'Burkina Faso': 'Africa/Ouagadougou',
  'Niger': 'Africa/Niamey',
  'Chad': 'Africa/Ndjamena',
  'Cameroon': 'Africa/Douala',
  'Central African Rep.': 'Africa/Bangui',
  'Gabon': 'Africa/Libreville',
  'Congo': 'Africa/Brazzaville',
  'Dem. Rep. Congo': 'Africa/Kinshasa',     // MULTI
  'Angola': 'Africa/Luanda',
  'Zambia': 'Africa/Lusaka',
  'Zimbabwe': 'Africa/Harare',
  'Malawi': 'Africa/Blantyre',
  'Mozambique': 'Africa/Maputo',
  'Botswana': 'Africa/Gaborone',
  'Namibia': 'Africa/Windhoek',
  'South Africa': 'Africa/Johannesburg',
  'Lesotho': 'Africa/Maseru',
  'eSwatini': 'Africa/Mbabane',
  'Madagascar': 'Indian/Antananarivo',
  'Mauritania': 'Africa/Nouakchott',
  'Guinea': 'Africa/Conakry',
  'Sierra Leone': 'Africa/Freetown',
  'Liberia': 'Africa/Monrovia',
  'Togo': 'Africa/Lome',
  'Benin': 'Africa/Porto-Novo',
  'Gambia': 'Africa/Banjul',
  'Guinea-Bissau': 'Africa/Bissau',
  'Eq. Guinea': 'Africa/Malabo',
  // ── Americas ────────────────────────────────────────────────────────────
  'United States of America': 'America/New_York',   // MULTI — six zones
  'Canada': 'America/Toronto',                      // MULTI — six zones
  'Mexico': 'America/Mexico_City',                  // MULTI
  'Guatemala': 'America/Guatemala',
  'Belize': 'America/Belize',
  'El Salvador': 'America/El_Salvador',
  'Honduras': 'America/Tegucigalpa',
  'Nicaragua': 'America/Managua',
  'Costa Rica': 'America/Costa_Rica',
  'Panama': 'America/Panama',
  'Cuba': 'America/Havana',
  'Jamaica': 'America/Jamaica',
  'Haiti': 'America/Port-au-Prince',
  'Dominican Rep.': 'America/Santo_Domingo',
  'Puerto Rico': 'America/Puerto_Rico',
  'Trinidad and Tobago': 'America/Port_of_Spain',
  'Bahamas': 'America/Nassau',
  'Colombia': 'America/Bogota',
  'Venezuela': 'America/Caracas',
  'Guyana': 'America/Guyana',
  'Suriname': 'America/Paramaribo',
  'Ecuador': 'America/Guayaquil',
  'Peru': 'America/Lima',
  'Bolivia': 'America/La_Paz',
  'Brazil': 'America/Sao_Paulo',                    // MULTI — four zones
  'Paraguay': 'America/Asuncion',
  'Uruguay': 'America/Montevideo',
  'Chile': 'America/Santiago',                      // MULTI
  'Argentina': 'America/Argentina/Buenos_Aires',
  'Greenland': 'America/Nuuk',
  // ── Oceania ─────────────────────────────────────────────────────────────
  'Australia': 'Australia/Sydney',                  // MULTI — five zones
  'New Zealand': 'Pacific/Auckland',
  'Papua New Guinea': 'Pacific/Port_Moresby',
  'Fiji': 'Pacific/Fiji',
  'Solomon Is.': 'Pacific/Guadalcanal',
  'Vanuatu': 'Pacific/Efate',
  'New Caledonia': 'Pacific/Noumea',
}

export interface Country extends CountryBounds { zone: string }

/** Every country the portal can convert times for, alphabetical. A country
    without a zone is left out on purpose: offering it would mean offering a
    conversion this file cannot actually make. */
export const COUNTRIES: Country[] = COUNTRY_BOUNDS
  .filter(c => COUNTRY_ZONES[c.name])
  .map(c => ({ ...c, zone: COUNTRY_ZONES[c.name] }))
  .sort((a, b) => a.name.localeCompare(b.name))

const BY_NAME = new Map(COUNTRIES.map(c => [c.name, c]))
export const countryByName = (name: string) => BY_NAME.get(name)

/**
 * The country whose zone matches an IANA zone name.
 *
 * Several countries legitimately share one zone (Kosovo and Serbia both read
 * Europe/Belgrade), so the first alphabetically wins. That only affects the
 * label shown next to the clock — the conversion is identical either way.
 */
/**
 * Legacy IANA zone names, mapped to the modern one.
 *
 * Browsers still report the old spelling — Chrome on an Indian machine says
 * `Asia/Calcutta`, not `Asia/Kolkata`. Both are the same zone and both format
 * identically, so this changes nothing about the conversion; it is only so the
 * header can say "India" instead of falling back to the raw zone name.
 */
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Asia/Istanbul': 'Europe/Istanbul',
  'Asia/Tel_Aviv': 'Asia/Jerusalem',
  'Europe/Kiev': 'Europe/Kyiv',
  'Europe/Nicosia': 'Asia/Nicosia',
  'Africa/Asmera': 'Africa/Asmara',
  'Africa/Timbuktu': 'Africa/Bamako',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Godthab': 'America/Nuuk',
  'America/Rosario': 'America/Argentina/Buenos_Aires',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Pacific': 'America/Los_Angeles',
  'GB': 'Europe/London',
  'GB-Eire': 'Europe/London',
}

/** The modern name for a zone, so lookups do not miss on a legacy spelling. */
export const canonicalZone = (zone: string) => ZONE_ALIASES[zone] ?? zone

const BY_ZONE = new Map<string, Country>()
for (const c of COUNTRIES) if (!BY_ZONE.has(c.zone)) BY_ZONE.set(c.zone, c)
export const countryForZone = (zone: string) => BY_ZONE.get(canonicalZone(zone))

/** The country an ISO 3166-1 alpha-2 code names, when we can convert its
    times. An unknown or unmapped code is undefined, never a guess. */
export function countryForISO(code: string): Country | undefined {
  const name = ISO_TO_COUNTRY[String(code).trim().toUpperCase()]
  return name ? BY_NAME.get(name) : undefined
}

/**
 * Which country a device location falls in.
 *
 * Tested against the actual outline, not a rectangle around it. A box big
 * enough to hold Vietnam — long, thin and bent around Cambodia — also holds
 * Phnom Penh, and a box drawn around South Africa swallows Lesotho whole. The
 * ray-crossing test below gets both right, and returns nothing at all for a
 * point at sea rather than the nearest guess: "we could not tell, pick one" is
 * a better answer than a confident wrong country.
 *
 * The outlines are loaded on demand. They are the largest thing this feature
 * ships and only a location lookup needs them, so a page that never asks never
 * pays for them.
 *
 * Resolution is Natural Earth 1:110m, decimated: good to roughly half a degree.
 * That is right for choosing a clock and wrong for anything that turns on which
 * side of a border a point sits — a city-state smaller than the tolerance (Singapore
 * is not in this dataset at all) simply comes back undefined, which leaves the
 * browser's own zone in place. That is the safe failure.
 */
export async function countryForCoords(lat: number, lon: number): Promise<Country | undefined> {
  let shapes
  try {
    ({ COUNTRY_SHAPES: shapes } = await import('./countryShapes'))
  } catch {
    return undefined
  }
  // Smallest matching outline wins, so an enclave beats the country around it.
  let best: string | undefined
  let bestSize = Infinity
  for (const [name, rings] of shapes) {
    for (const ring of rings) {
      if (!pointInRing(lon, lat, ring)) continue
      if (ring.length < bestSize) { bestSize = ring.length; best = name }
      break
    }
  }
  return best ? BY_NAME.get(best) : undefined
}

/** Ray crossing on a flat [lon, lat, lon, lat, …] ring. */
function pointInRing(lon: number, lat: number, r: number[]): boolean {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1]
    const xj = r[j], yj = r[j + 1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}
