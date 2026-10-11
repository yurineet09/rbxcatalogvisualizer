/* ===== Site settings: edit here ===== */
const CONFIG = {
  contactEmail: "yurineet09.vercel.app",   // <-- change me

  // Own Vercel proxy (api/rbx.js). Set to "" to use the public roproxy mirrors below instead.
  proxy: "/api/rbx",
  api: {
    economy:    "https://economy.roproxy.com",
    catalog:    "https://catalog.roproxy.com",
    thumbnails: "https://thumbnails.roproxy.com"
  },

  years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013],
  pageSize: 120,        // items per Roblox search request (falls back to 30 automatically if Roblox refuses it)
  perPage: 20,          // items per displayed page (5 columns x 4 rows, like old ROBLOX)
  prefetchPages: 3,     // on a new search, load this many display pages ahead so the pager shows 1 2 3 ...
  maxPulls: 8,          // throttle each step; Next/Search deeper continues safely without triggering Roblox 429s
  maxPullsCommunity: 14, // community clothing is a huge pool with few 2006-2013 items, so scan deeper per step
  relatedMax: 12,       // Related Items: 6 visible + 6 more by scrolling horizontally
  packagesIgnoreEra: true, // Packages are Bundles on Roblox and report the bundle's (re)creation date, so the 2006-2013 filter would hide all of them
  maxAssetId: 600000000 // asset IDs above this are newer than 2013: skipped WITHOUT asking Roblox for details (big speed-up)
};

const ALL_CATS = ["Accessories", "Gear", "Shirts", "T-Shirts", "Pants", "BodyParts"];   // feeds "All" searches in turn (Roblox-published)

// Words ignored when looking for the "style" of an item (Related Items)
const STOP = new Set(["the","and","for","with","from","roblox","classic","hat","hats","cap","hair","mask","item","free","limited","edition","pack","set","new","old","big","little","small","red","blue","green","black","white","gold","golden","silver","your","this","that","pants","shirt","tshirt","face","head","gear","package","of","a","an"]);

// Roblox AssetTypeId -> label
// Roblox AssetTypeId -> label. Only types that existed in the 2006-2013 catalog.
// 41-47 are the "accessory" types that old hair/hats were later converted to.
const ASSET_TYPES = {8:"Hat",41:"Accessory",42:"Accessory",43:"Accessory",44:"Accessory",45:"Accessory",46:"Accessory",47:"Accessory",
  19:"Gear",2:"T-Shirt",11:"Shirt",12:"Pants",18:"Face",17:"Head",32:"Package",27:"Torso",28:"Right Arm",29:"Left Arm",30:"Left Leg",31:"Right Leg"};

// Catalog search query per feed. Each feed lists variants: the first one is tried and, if Roblox
// answers 400 / returns an empty first page, the next (broader) one is used. Items are always
// re-checked by asset type on our side, so a broader variant only costs extra pages, never wrong items.
const CAT_QUERY = {
  Accessories: ["Category=11"],
  Gear:        ["Category=11&Subcategory=5"],
  Clothing:    ["Category=3"],
  Shirts:      ["Category=3&Subcategory=12", "Category=3"],
  "T-Shirts":  ["Category=3&Subcategory=13", "Category=3"],
  Pants:       ["Category=3&Subcategory=14", "Category=3"],
  BodyParts:   ["Category=4"],
  Faces:       ["Category=4&Subcategory=10", "Category=4"],
  Heads:       ["Category=4&Subcategory=15", "Category=4"],
  Packages:    ["Category=4&Subcategory=11", "Category=4"]
};

// Fixed category list (never depends on what happened to load). feed = key of CAT_QUERY.
const CATEGORIES = {
  "All":         {types: null},
  "Hats":        {types: ["Hat"], feed: "Accessories"},
  "Accessories": {types: ["Accessory"], feed: "Accessories"},
  "Gear":        {types: ["Gear"], feed: "Gear"},
  "T-Shirts":    {types: ["T-Shirt"], feed: "T-Shirts"},
  "Shirts":      {types: ["Shirt"], feed: "Shirts"},
  "Pants":       {types: ["Pants"], feed: "Pants"},
  "Faces":       {types: ["Face"], feed: "Faces"},
  "Heads":       {types: ["Head"], feed: "Heads"},
  "Packages":    {types: ["Package"], feed: "Packages"},
  "Body Parts":  {types: ["Torso","Right Arm","Left Arm","Left Leg","Right Leg"], feed: "BodyParts"}
};
const COMMUNITY_CATEGORIES = ["All", "T-Shirts", "Shirts", "Pants"];
// item type -> feed (used by Related Items to search inside the right category)
const TYPE_FEED = {Hat:"Accessories", Accessory:"Accessories", Gear:"Gear", "T-Shirt":"T-Shirts", Shirt:"Shirts", Pants:"Pants",
  Face:"Faces", Head:"Heads", Package:"Packages", Torso:"BodyParts", "Right Arm":"BodyParts", "Left Arm":"BodyParts", "Left Leg":"BodyParts", "Right Leg":"BodyParts"};
