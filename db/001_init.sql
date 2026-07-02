-- Schemat bazy WMS dla Subiekt GT
-- Tabela 1: lokalizacje
CREATE TABLE lokalizacje (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kod TEXT NOT NULL UNIQUE,         -- np. M2-J14-P2
  magazyn TEXT NOT NULL,            -- K4 lub K4G
  aktywna INTEGER NOT NULL DEFAULT 1,
  -- cechy strukturalne wyliczane z kodu (services/lokalizacje-model), do filtrow/raportow
  hala TEXT,                        -- '1' | 'M2' | NULL (nazwana)
  regal TEXT,                       -- A..L | NULL
  alejka INTEGER,                   -- 1..6 (para regalow) | NULL
  strona TEXT,                      -- 'a' | 'b' | NULL
  kolumna INTEGER,                  -- numer po literze regalu | NULL
  typ TEXT,                         -- 'paleta' | 'trawers' | 'polka' | 'nazwana'
  utworzona DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_lok_typ ON lokalizacje(typ);
CREATE INDEX idx_lok_alejka ON lokalizacje(alejka);

-- Tabela 2: stany lokalizacji
CREATE TABLE stany_lokalizacji (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lokalizacja_id INTEGER NOT NULL REFERENCES lokalizacje(id),
  artykul_gt_id TEXT NOT NULL,      -- tw_Id z GT
  artykul_symbol TEXT NOT NULL,
  artykul_nazwa TEXT NOT NULL,
  artykul_ean TEXT,                 -- kod EAN z GT (opcjonalny)
  ilosc DECIMAL NOT NULL DEFAULT 0,
  ostatnia_zmiana DATETIME DEFAULT CURRENT_TIMESTAMP,
  operator TEXT,
  UNIQUE(lokalizacja_id, artykul_gt_id)
);

-- Tabela 3: ruchy
CREATE TABLE ruchy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  typ TEXT NOT NULL,                -- LOK lub MM
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT NOT NULL,
  lok_zrodlo_id INTEGER REFERENCES lokalizacje(id),   -- NULL przy LOK
  lok_cel_id INTEGER REFERENCES lokalizacje(id),      -- NULL gdy cel = ZEW
  mag_cel_zewnetrzny TEXT,          -- np. ZEW1 gdy cel to mag. zewnętrzny
  ilosc DECIMAL NOT NULL,
  dok_gt_numer TEXT,                -- numer MM w GT, NULL przy LOK
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / ok / error
  blad_opis TEXT,
  data_ruchu DATETIME DEFAULT CURRENT_TIMESTAMP,
  operator TEXT
);

-- Tabela 4: rozjazdy
CREATE TABLE rozjazdy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artykul_gt_id TEXT NOT NULL,
  artykul_symbol TEXT NOT NULL,
  magazyn TEXT NOT NULL,
  ilosc_gt DECIMAL NOT NULL,
  ilosc_wms DECIMAL NOT NULL,
  roznica DECIMAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'nowy',     -- nowy / wyjasniony
  opis TEXT,
  wykryty DATETIME DEFAULT CURRENT_TIMESTAMP,
  wyjasniony DATETIME,
  operator TEXT
);

-- Indeksy
CREATE INDEX idx_lokalizacje_magazyn ON lokalizacje(magazyn);
CREATE INDEX idx_stany_artykul ON stany_lokalizacji(artykul_gt_id);
CREATE INDEX idx_stany_ean ON stany_lokalizacji(artykul_ean);
CREATE INDEX idx_stany_lokalizacja ON stany_lokalizacji(lokalizacja_id);
CREATE INDEX idx_ruchy_artykul ON ruchy(artykul_gt_id);
CREATE INDEX idx_ruchy_status ON ruchy(status);
CREATE INDEX idx_rozjazdy_status ON rozjazdy(status);
