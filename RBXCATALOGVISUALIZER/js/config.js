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
  maxPulls: 12,         // max Roblox search requests per "load" step (keeps the site fast; "Next" loads more)
  maxAssetId: 600000000 // asset IDs above this are newer than 2013: skipped WITHOUT asking Roblox for details (big speed-up)
};

const ALL_CATS = ["Accessories", "Gear", "Clothing", "BodyParts"];   // what "All" searches in turn

// Words ignored when looking for the "style" of an item (Related Items)
const STOP = new Set(["the","and","for","with","from","roblox","classic","hat","hats","cap","hair","mask","item","free","limited","edition","pack","set","new","old","big","little","small","red","blue","green","black","white","gold","golden","silver","your","this","that","pants","shirt","tshirt","face","head","gear","package","of","a","an"]);

// Roblox AssetTypeId -> label
// Roblox AssetTypeId -> label. Only types that existed in the 2006-2013 catalog.
// 41-47 are the "accessory" types that old hair/hats were later converted to.
const ASSET_TYPES = {8:"Hat",41:"Accessory",42:"Accessory",43:"Accessory",44:"Accessory",45:"Accessory",46:"Accessory",47:"Accessory",
  19:"Gear",2:"T-Shirt",11:"Shirt",12:"Pants",18:"Face",17:"Head",32:"Package",27:"Torso",28:"Right Arm",29:"Left Arm",30:"Left Leg",31:"Right Leg"};

// Fixed category list (never depends on what happened to load). api = catalog search category.
const CATEGORIES = {
  "All":         {types: null},
  "Hats":        {types: ["Hat"], api: "Accessories"},
  "Accessories": {types: ["Accessory"], api: "Accessories"},
  "Gear":        {types: ["Gear"], api: "Gear"},
  "T-Shirts":    {types: ["T-Shirt"], api: "Clothing"},
  "Shirts":      {types: ["Shirt"], api: "Clothing"},
  "Pants":       {types: ["Pants"], api: "Clothing"},
  "Faces":       {types: ["Face"], api: "BodyParts"},
  "Heads":       {types: ["Head"], api: "BodyParts"},
  "Packages":    {types: ["Package"], api: "BodyParts"},
  "Body Parts":  {types: ["Torso","Right Arm","Left Arm","Left Leg","Right Leg"], api: "BodyParts"}
};
const COMMUNITY_CATEGORIES = ["All", "T-Shirts", "Shirts", "Pants"];