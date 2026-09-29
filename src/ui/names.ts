const PREFIX = ['River', 'Oak', 'Stone', 'Maple', 'Green', 'Clear', 'Silver', 'Pine', 'Lake', 'North', 'Fair', 'Bright', 'Elm', 'Cedar', 'Willow', 'Hill', 'Red', 'Ash', 'Brook', 'Summer'];
const SUFFIX = ['ton', 'ville', ' Falls', 'field', 'bury', ' Springs', 'wood', 'haven', 'port', 'ford', ' Heights', 'dale', 'stead', 'mouth'];

export function randomCityName(): string {
  const p = PREFIX[Math.floor(Math.random() * PREFIX.length)];
  const s = SUFFIX[Math.floor(Math.random() * SUFFIX.length)];
  return p + s;
}
