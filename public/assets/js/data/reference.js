/**
 * Static reference data (carried over verbatim from the original app).
 *
 *  - SECTOR_MAP   symbol base -> sector (CSE retail-friendly groups)
 *  - SEASON       month -> [symbol, company, note, strength]  (historical pattern)
 *  - DIV_PROFILE  per-symbol dividend profile
 *
 * Analysis only — history-based patterns, NOT guaranteed. Edit freely to add
 * symbols; the UI picks up changes automatically.
 */

export const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const SECTOR_MAP = {
  COMB:'Banks',HNB:'Banks',SAMP:'Banks',SEYB:'Banks',NDB:'Banks',DFCC:'Banks',NTB:'Banks',PABC:'Banks',UBC:'Banks',
  PLC:'Finance',LFIN:'Finance',CFIN:'Finance',CSF:'Finance',
  JKH:'Diversified',HAYL:'Diversified',RICH:'Diversified',SPEN:'Diversified',CARG:'Diversified',
  CTC:'Food & Beverage',NEST:'Food & Beverage',LION:'Food & Beverage',BREW:'Food & Beverage',CCS:'Food & Beverage',
  DIAL:'Telecom',SLTL:'Telecom',
  LIOC:'Energy',LLUB:'Energy',
  DIST:'Beverage',
  TILE:'Construction',ACL:'Construction',TKYO:'Construction',
  TJL:'Manufacturing',DIPD:'Manufacturing',HAYC:'Manufacturing',
  WATA:'Plantations',KEL:'Plantations',
  RFL:'Hotels',RENU:'Hotels',AHUN:'Hotels',
  UML:'Motors',
  COCO:'Food & Beverage',LMF:'Manufacturing',RIL:'Manufacturing'
};

/* Historical seasonality (pattern-based, not live announcements) */
export const SEASON = {
  1:[["CTC","Ceylon Tobacco","Often Q4/interim around year-start","med"],["NEST","Nestle Lanka","Occasional","low"]],
  2:[["COMB","Commercial Bank","AGM season; final often announced","high"],["HNB","Hatton National Bank","Bank final dividend cycle","high"],["SAMP","Sampath Bank","Bank AGM / final cycle","high"],["SEYB","Seylan Bank","Bank final cycle","high"],["NDB","National Development Bank","Bank final cycle","med"],["DFCC","DFCC Bank","Bank final cycle","med"],["NTB","Nations Trust Bank","Bank final cycle","med"]],
  3:[["COMB","Commercial Bank","XD often late Mar / early Apr","high"],["HNB","Hatton National Bank","XD often Mar/Apr","high"],["SAMP","Sampath Bank","XD often Mar/Apr","high"],["JKH","John Keells Holdings","Final/interim cycle","med"],["LION","Lion Brewery","Often around this period","med"],["CCS","Ceylon Cold Stores","Group cycle","med"]],
  4:[["COMB","Commercial Bank","Very common XD/payment month","high"],["HNB","Hatton National Bank","Very common XD/payment","high"],["SAMP","Sampath Bank","Very common XD/payment","high"],["SEYB","Seylan Bank","Common XD/payment","high"],["NDB","National Development Bank","Common","med"],["PLC","People's Leasing","Finance sector finals","med"],["CARG","Cargills","Retail group cycle","med"]],
  5:[["CTC","Ceylon Tobacco","Multiple interims; often May window","high"],["DIAL","Dialog Axiata","Telecom dividend cycle","med"],["SLTL","Sri Lanka Telecom","Telecom cycle","med"],["LIOC","Lanka IOC","Energy sector","med"]],
  6:[["CTC","Ceylon Tobacco","Interim window common","high"],["NEST","Nestle Lanka","Mid-year possible","med"],["HAYL","Hayleys","Conglomerate cycle","med"],["RICH","Richard Pieris","Group cycle","med"]],
  7:[["CTC","Ceylon Tobacco","Interim possible","med"],["LLUB","Lanka Lubricants","Occasional","low"],["DIPD","Dipped Products","Industrial cycle","med"]],
  8:[["CTC","Ceylon Tobacco","Interim often Aug window","high"],["TJL","Teejay Lanka","Textile cycle","med"],["HEXP","Hexpure","Occasional","low"]],
  9:[["CTC","Ceylon Tobacco","Strong history of interims around Sep","high"],["HARI","Harischandra Mills","Often final around Sep window","high"],["GEST","Gestetner of Ceylon","Often Sep final cycle","high"],["LALU","Lanka Aluminium","Often Sep final","med"],["LHCL","Lee Hedges","Often Sep final","med"],["RENU","Renuka Hotels / City","Group often Sep","med"],["RFL","Ramboda Falls","Hotel / tourism cycle","med"],["ABAN","Abans Electricals","Often Sep final window","med"],["CTEA","Ceylon Tea Brokers","Tea sector often Sep","med"],["CARG","Cargills","Sometimes mid-year","low"],["TILE","Lanka Tiles","Building materials cycle","med"],["UML","United Motors","Auto sector cycle","med"],["WATA","Watawala","Plantation cycle","med"],["HAYC","Haycarb","Hayleys group","med"]],
  10:[["CTC","Ceylon Tobacco","Interim / payment possible","med"],["JKH","John Keells Holdings","Sometimes Oct window","med"],["DIST","Distilleries Company","Occasionally","med"],["SPEN","Sunshine Holdings","Group cycle","med"]],
  11:[["CTC","Ceylon Tobacco","Often Nov interim","high"],["NEST","Nestle Lanka","Year-end approach","med"],["LION","Lion Brewery","Possible","med"],["BREW","Ceylon Beverage","Group","med"]],
  12:[["CTC","Ceylon Tobacco","Year-end interim common","high"],["JKH","John Keells Holdings","Possible year-end","med"],["CARG","Cargills","Possible","low"],["HAYL","Hayleys","Year-end possible","med"]]
};

/* Per-symbol dividend profile (pattern + typical months + notes). */
export const DIV_PROFILE = {
  CTC:{name:'Ceylon Tobacco',months:[1,5,6,8,9,11,12],strength:'high',freq:'Multiple interims / year',note:'Strong history of several cash dividends across the year; Sep & Nov windows common.',typicalDps:'Often relatively high DPS vs price'},
  COMB:{name:'Commercial Bank',months:[2,3,4],strength:'high',freq:'Final (AGM season)',note:'Bank final dividend cycle — announce around Feb–Mar, XD often Mar/Apr.',typicalDps:'Linked to annual profit'},
  HNB:{name:'Hatton National Bank',months:[2,3,4],strength:'high',freq:'Final (AGM season)',note:'Similar bank cycle to COMB/SAMP — Feb–Apr window.',typicalDps:'Linked to annual profit'},
  SAMP:{name:'Sampath Bank',months:[2,3,4],strength:'high',freq:'Final (AGM season)',note:'Bank AGM / final cycle; XD often Mar/Apr.',typicalDps:'Linked to annual profit'},
  SEYB:{name:'Seylan Bank',months:[2,4],strength:'high',freq:'Final',note:'Bank final cycle.',typicalDps:'Varies with profits'},
  NDB:{name:'National Development Bank',months:[2,4],strength:'med',freq:'Final',note:'Bank final cycle.',typicalDps:'Varies'},
  DFCC:{name:'DFCC Bank',months:[2],strength:'med',freq:'Final',note:'Bank final cycle.',typicalDps:'Varies'},
  NTB:{name:'Nations Trust Bank',months:[2],strength:'med',freq:'Final',note:'Bank final cycle.',typicalDps:'Varies'},
  JKH:{name:'John Keells Holdings',months:[3,10,12],strength:'med',freq:'Final / interim',note:'Conglomerate — final and occasional interim windows.',typicalDps:'Group dependent'},
  LION:{name:'Lion Brewery',months:[3,11],strength:'med',freq:'Periodic',note:'Beverage group cycle.',typicalDps:'Varies'},
  CCS:{name:'Ceylon Cold Stores',months:[3],strength:'med',freq:'Group cycle',note:'JKH group related timing possible.',typicalDps:'Varies'},
  DIAL:{name:'Dialog Axiata',months:[5],strength:'med',freq:'Telecom cycle',note:'Telecom dividend window often mid-year.',typicalDps:'Policy-based'},
  SLTL:{name:'Sri Lanka Telecom',months:[5],strength:'med',freq:'Telecom cycle',note:'Telecom sector timing.',typicalDps:'Policy-based'},
  LIOC:{name:'Lanka IOC',months:[5],strength:'med',freq:'Energy',note:'Energy sector — check annual results.',typicalDps:'Varies with margins'},
  NEST:{name:'Nestle Lanka',months:[1,6,11],strength:'med',freq:'Occasional / mid-year',note:'Consumer staple — mid-year and year-end possible.',typicalDps:'Usually steady'},
  HAYL:{name:'Hayleys',months:[6,12],strength:'med',freq:'Conglomerate',note:'Group cycle — mid and year-end possible.',typicalDps:'Group dependent'},
  RICH:{name:'Richard Pieris',months:[6],strength:'med',freq:'Group',note:'Group cycle.',typicalDps:'Varies'},
  HARI:{name:'Harischandra Mills',months:[9],strength:'high',freq:'Often Sep final',note:'Strong Sep final history in pattern data.',typicalDps:'Check history site'},
  GEST:{name:'Gestetner of Ceylon',months:[9],strength:'high',freq:'Often Sep final',note:'Sep final cycle common.',typicalDps:'Check history site'},
  CARG:{name:'Cargills',months:[4,9,12],strength:'med',freq:'Retail group',note:'Retail — several possible windows.',typicalDps:'Varies'},
  DIST:{name:'Distilleries Company',months:[10],strength:'med',freq:'Occasional',note:'Sometimes Oct window.',typicalDps:'Varies'},
  SPEN:{name:'Sunshine Holdings',months:[10],strength:'med',freq:'Group',note:'Group cycle.',typicalDps:'Varies'},
  TJL:{name:'Teejay Lanka',months:[8],strength:'med',freq:'Textile',note:'Textile sector cycle.',typicalDps:'Varies'},
  TILE:{name:'Lanka Tiles',months:[9],strength:'med',freq:'Building materials',note:'Often around Sep in pattern data.',typicalDps:'Varies'},
  WATA:{name:'Watawala',months:[9],strength:'med',freq:'Plantation',note:'Plantation sector cycle.',typicalDps:'Crop / profit dependent'},
  HAYC:{name:'Haycarb',months:[9],strength:'med',freq:'Hayleys group',note:'Group timing.',typicalDps:'Varies'},
  LALU:{name:'Lanka Aluminium',months:[9],strength:'med',freq:'Often Sep',note:'Sep final common in pattern.',typicalDps:'Check history'},
  ABAN:{name:'Abans Electricals',months:[9],strength:'med',freq:'Often Sep',note:'Sep final window in pattern.',typicalDps:'Check history'},
  PLC:{name:'People\'s Leasing',months:[4],strength:'med',freq:'Finance finals',note:'Finance sector finals.',typicalDps:'Varies'},
  DIPD:{name:'Dipped Products',months:[7],strength:'med',freq:'Industrial',note:'Industrial cycle.',typicalDps:'Varies'},
  LLUB:{name:'Lanka Lubricants',months:[7],strength:'low',freq:'Occasional',note:'Less frequent in pattern data.',typicalDps:'Check history'},
  BREW:{name:'Ceylon Beverage',months:[11],strength:'med',freq:'Group',note:'Beverage group.',typicalDps:'Varies'},
  RFL:{name:'Ramboda Falls',months:[9],strength:'med',freq:'Hotel / tourism',note:'Tourism cycle often Sep.',typicalDps:'Seasonal'},
  RENU:{name:'Renuka Hotels / City',months:[9],strength:'med',freq:'Group often Sep',note:'Sep final common.',typicalDps:'Check history'},
  CTEA:{name:'Ceylon Tea Brokers',months:[9],strength:'med',freq:'Tea sector',note:'Tea sector often Sep.',typicalDps:'Varies'},
  UML:{name:'United Motors',months:[9],strength:'med',freq:'Auto sector',note:'Auto sector cycle.',typicalDps:'Varies'},
  LHCL:{name:'Lee Hedges',months:[9],strength:'med',freq:'Often Sep final',note:'Sep final in pattern.',typicalDps:'Check history'},
  HEXP:{name:'Hexpure',months:[8],strength:'low',freq:'Occasional',note:'Less frequent.',typicalDps:'Check history'}
};
