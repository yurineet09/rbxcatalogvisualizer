/* ===== Site settings: edit here ===== */
const CONFIG = {
  contactEmail: "yurineet09.vercel.app",   // <-- change me

  // Roblox web APIs. Browsers block direct calls from other sites (CORS), so these point to
  // the public roproxy mirror. For production, host your own proxy and replace these bases.
  api: {
    economy:    "https://economy.roproxy.com",
    catalog:    "https://catalog.roproxy.com",
    thumbnails: "https://thumbnails.roproxy.com"
  },

  years: [2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013],
  pageSize: 30,
  perPage: 20   // items per displayed page (5 columns x 4 rows, like old ROBLOX)
};

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