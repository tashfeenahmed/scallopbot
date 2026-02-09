/**
 * Country-to-IANA timezone mapping.
 *
 * Maps common/short country names (lowercase) to their primary IANA timezone.
 * Countries with multiple timezones use the most populous city's timezone.
 */

/** Country name (lowercase) → IANA timezone */
const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  // A
  'afghanistan': 'Asia/Kabul',
  'albania': 'Europe/Tirane',
  'algeria': 'Africa/Algiers',
  'andorra': 'Europe/Andorra',
  'angola': 'Africa/Luanda',
  'antigua': 'America/Antigua',
  'argentina': 'America/Argentina/Buenos_Aires',
  'armenia': 'Asia/Yerevan',
  'australia': 'Australia/Sydney',
  'austria': 'Europe/Vienna',
  'azerbaijan': 'Asia/Baku',

  // B
  'bahamas': 'America/Nassau',
  'bahrain': 'Asia/Bahrain',
  'bangladesh': 'Asia/Dhaka',
  'barbados': 'America/Barbados',
  'belarus': 'Europe/Minsk',
  'belgium': 'Europe/Brussels',
  'belize': 'America/Belize',
  'benin': 'Africa/Porto-Novo',
  'bhutan': 'Asia/Thimphu',
  'bolivia': 'America/La_Paz',
  'bosnia': 'Europe/Sarajevo',
  'botswana': 'Africa/Gaborone',
  'brazil': 'America/Sao_Paulo',
  'brunei': 'Asia/Brunei',
  'bulgaria': 'Europe/Sofia',
  'burkina faso': 'Africa/Ouagadougou',
  'burundi': 'Africa/Bujumbura',

  // C
  'cambodia': 'Asia/Phnom_Penh',
  'cameroon': 'Africa/Douala',
  'canada': 'America/Toronto',
  'cape verde': 'Atlantic/Cape_Verde',
  'chad': 'Africa/Ndjamena',
  'chile': 'America/Santiago',
  'china': 'Asia/Shanghai',
  'colombia': 'America/Bogota',
  'comoros': 'Indian/Comoro',
  'congo': 'Africa/Brazzaville',
  'costa rica': 'America/Costa_Rica',
  'croatia': 'Europe/Zagreb',
  'cuba': 'America/Havana',
  'cyprus': 'Asia/Nicosia',
  'czech republic': 'Europe/Prague',
  'czechia': 'Europe/Prague',

  // D
  'denmark': 'Europe/Copenhagen',
  'djibouti': 'Africa/Djibouti',
  'dominica': 'America/Dominica',
  'dominican republic': 'America/Santo_Domingo',
  'dr congo': 'Africa/Kinshasa',

  // E
  'ecuador': 'America/Guayaquil',
  'egypt': 'Africa/Cairo',
  'el salvador': 'America/El_Salvador',
  'equatorial guinea': 'Africa/Malabo',
  'eritrea': 'Africa/Asmara',
  'estonia': 'Europe/Tallinn',
  'eswatini': 'Africa/Mbabane',
  'ethiopia': 'Africa/Addis_Ababa',

  // F
  'fiji': 'Pacific/Fiji',
  'finland': 'Europe/Helsinki',
  'france': 'Europe/Paris',

  // G
  'gabon': 'Africa/Libreville',
  'gambia': 'Africa/Banjul',
  'georgia': 'Asia/Tbilisi',
  'germany': 'Europe/Berlin',
  'ghana': 'Africa/Accra',
  'greece': 'Europe/Athens',
  'grenada': 'America/Grenada',
  'guatemala': 'America/Guatemala',
  'guinea': 'Africa/Conakry',
  'guyana': 'America/Guyana',

  // H
  'haiti': 'America/Port-au-Prince',
  'honduras': 'America/Tegucigalpa',
  'hungary': 'Europe/Budapest',

  // I
  'iceland': 'Atlantic/Reykjavik',
  'india': 'Asia/Kolkata',
  'indonesia': 'Asia/Jakarta',
  'iran': 'Asia/Tehran',
  'iraq': 'Asia/Baghdad',
  'ireland': 'Europe/Dublin',
  'israel': 'Asia/Jerusalem',
  'italy': 'Europe/Rome',
  'ivory coast': 'Africa/Abidjan',

  // J
  'jamaica': 'America/Jamaica',
  'japan': 'Asia/Tokyo',
  'jordan': 'Asia/Amman',

  // K
  'kazakhstan': 'Asia/Almaty',
  'kenya': 'Africa/Nairobi',
  'kiribati': 'Pacific/Tarawa',
  'kosovo': 'Europe/Belgrade',
  'kuwait': 'Asia/Kuwait',
  'kyrgyzstan': 'Asia/Bishkek',

  // L
  'laos': 'Asia/Vientiane',
  'latvia': 'Europe/Riga',
  'lebanon': 'Asia/Beirut',
  'lesotho': 'Africa/Maseru',
  'liberia': 'Africa/Monrovia',
  'libya': 'Africa/Tripoli',
  'liechtenstein': 'Europe/Vaduz',
  'lithuania': 'Europe/Vilnius',
  'luxembourg': 'Europe/Luxembourg',

  // M
  'madagascar': 'Indian/Antananarivo',
  'malawi': 'Africa/Blantyre',
  'malaysia': 'Asia/Kuala_Lumpur',
  'maldives': 'Indian/Maldives',
  'mali': 'Africa/Bamako',
  'malta': 'Europe/Malta',
  'mauritania': 'Africa/Nouakchott',
  'mauritius': 'Indian/Mauritius',
  'mexico': 'America/Mexico_City',
  'moldova': 'Europe/Chisinau',
  'monaco': 'Europe/Monaco',
  'mongolia': 'Asia/Ulaanbaatar',
  'montenegro': 'Europe/Podgorica',
  'morocco': 'Africa/Casablanca',
  'mozambique': 'Africa/Maputo',
  'myanmar': 'Asia/Yangon',

  // N
  'namibia': 'Africa/Windhoek',
  'nauru': 'Pacific/Nauru',
  'nepal': 'Asia/Kathmandu',
  'netherlands': 'Europe/Amsterdam',
  'new zealand': 'Pacific/Auckland',
  'nicaragua': 'America/Managua',
  'niger': 'Africa/Niamey',
  'nigeria': 'Africa/Lagos',
  'north korea': 'Asia/Pyongyang',
  'north macedonia': 'Europe/Skopje',
  'norway': 'Europe/Oslo',

  // O
  'oman': 'Asia/Muscat',

  // P
  'pakistan': 'Asia/Karachi',
  'palau': 'Pacific/Palau',
  'palestine': 'Asia/Hebron',
  'panama': 'America/Panama',
  'papua new guinea': 'Pacific/Port_Moresby',
  'paraguay': 'America/Asuncion',
  'peru': 'America/Lima',
  'philippines': 'Asia/Manila',
  'poland': 'Europe/Warsaw',
  'portugal': 'Europe/Lisbon',

  // Q
  'qatar': 'Asia/Qatar',

  // R
  'romania': 'Europe/Bucharest',
  'russia': 'Europe/Moscow',
  'rwanda': 'Africa/Kigali',

  // S
  'samoa': 'Pacific/Apia',
  'san marino': 'Europe/San_Marino',
  'saudi arabia': 'Asia/Riyadh',
  'senegal': 'Africa/Dakar',
  'serbia': 'Europe/Belgrade',
  'seychelles': 'Indian/Mahe',
  'sierra leone': 'Africa/Freetown',
  'singapore': 'Asia/Singapore',
  'slovakia': 'Europe/Bratislava',
  'slovenia': 'Europe/Ljubljana',
  'solomon islands': 'Pacific/Guadalcanal',
  'somalia': 'Africa/Mogadishu',
  'south africa': 'Africa/Johannesburg',
  'south korea': 'Asia/Seoul',
  'south sudan': 'Africa/Juba',
  'spain': 'Europe/Madrid',
  'sri lanka': 'Asia/Colombo',
  'sudan': 'Africa/Khartoum',
  'suriname': 'America/Paramaribo',
  'sweden': 'Europe/Stockholm',
  'switzerland': 'Europe/Zurich',
  'syria': 'Asia/Damascus',

  // T
  'taiwan': 'Asia/Taipei',
  'tajikistan': 'Asia/Dushanbe',
  'tanzania': 'Africa/Dar_es_Salaam',
  'thailand': 'Asia/Bangkok',
  'togo': 'Africa/Lome',
  'tonga': 'Pacific/Tongatapu',
  'trinidad': 'America/Port_of_Spain',
  'trinidad and tobago': 'America/Port_of_Spain',
  'tunisia': 'Africa/Tunis',
  'turkey': 'Europe/Istanbul',
  'turkmenistan': 'Asia/Ashgabat',
  'tuvalu': 'Pacific/Funafuti',

  // U
  'uganda': 'Africa/Kampala',
  'ukraine': 'Europe/Kyiv',
  'uae': 'Asia/Dubai',
  'united arab emirates': 'Asia/Dubai',
  'uk': 'Europe/London',
  'united kingdom': 'Europe/London',
  'england': 'Europe/London',
  'scotland': 'Europe/London',
  'wales': 'Europe/London',
  'northern ireland': 'Europe/London',
  'usa': 'America/New_York',
  'us': 'America/New_York',
  'united states': 'America/New_York',
  'america': 'America/New_York',
  'uruguay': 'America/Montevideo',
  'uzbekistan': 'Asia/Tashkent',

  // V
  'vanuatu': 'Pacific/Efate',
  'vatican': 'Europe/Vatican',
  'venezuela': 'America/Caracas',
  'vietnam': 'Asia/Ho_Chi_Minh',

  // Y
  'yemen': 'Asia/Aden',

  // Z
  'zambia': 'Africa/Lusaka',
  'zimbabwe': 'Africa/Harare',
};

/**
 * Lookup a timezone by country name. Case-insensitive.
 * Returns the IANA timezone string if found, or null if no match.
 */
export function getTimezoneByCountry(country: string): string | null {
  const normalized = country.trim().toLowerCase();
  return COUNTRY_TIMEZONE_MAP[normalized] ?? null;
}

/**
 * Resolve user input to an IANA timezone.
 *
 * Tries in order:
 *   1. Direct IANA timezone validation (e.g. "Europe/Dublin")
 *   2. Country name lookup (e.g. "Ireland" → "Europe/Dublin")
 *
 * Returns `{ timezone, source }` on success, or `null` if unresolvable.
 */
export function resolveTimezone(input: string): { timezone: string; source: 'iana' | 'country' } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Try as direct IANA timezone
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return { timezone: trimmed, source: 'iana' };
  } catch {
    // Not a valid IANA name — try country lookup
  }

  // 2. Try country name lookup
  const tz = getTimezoneByCountry(trimmed);
  if (tz) {
    return { timezone: tz, source: 'country' };
  }

  return null;
}
