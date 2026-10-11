//! The tile store host (the page's `TileStore`): the engine's tile cache plus what it leaves to its host — loading
//! and decoding a stored tile it asks for, and encoding and storing the tiles it evicts or flushes as `tile/` and
//! `tile-index/` rows. Tiles are PNG, encoded with the same `png` crate settings the page uses
//! (`rust/wasm/src/png.rs`: `Compression::Fast`, the default adaptive filter), so the bytes are the same.

use crate::store::Store;
use crate::value::{Js, Obj, Typed};
use long_screen_engine::tiles::{StoredTile, Tile, TileCache, TileKey};
use std::io::Cursor;

/// RGBA → PNG, as `ls_png_encode` does.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// PNG → RGBA (8-bit grey, grey+alpha, RGB or RGBA), with its size.
pub fn decode_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let (width, height) = reader.info().size();
    let mut raw = vec![0u8; reader.output_buffer_size().ok_or("PNG too large")?];
    reader.next_frame(&mut raw).map_err(|e| e.to_string())?;
    let (color, depth) = reader.output_color_type();
    if depth != png::BitDepth::Eight {
        return Err("only 8-bit PNG is supported".into());
    }
    let n = (width * height) as usize;
    let rgba = match color {
        png::ColorType::Rgba => {
            raw.truncate(n * 4);
            raw
        }
        png::ColorType::Rgb => raw[..n * 3]
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => raw[..n * 2]
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => raw[..n].iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("palette PNG is not supported".into()),
    };
    Ok((width, height, rgba))
}

fn le_u32(b: &[u8]) -> Vec<u32> {
    b.chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn le_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

/// The engine's tile cache and the rows behind it.
pub struct Tiles {
    pub cache: TileCache,
    pub size: usize,
}

impl Tiles {
    pub fn new(size: usize, memory_mb: f64) -> Result<Tiles, String> {
        let cache = TileCache::new(size, memory_mb).map_err(|e| format!("{e:?}"))?;
        Ok(Tiles { cache, size })
    }

    /// The `tile/` and `tile-index/` rows of a tile, as the page encodes them.
    fn rows(&mut self, t: &Tile) -> Result<[(String, Js); 2], String> {
        self.cache.encoded();
        let blob = encode_png(&t.pixels, self.size as u32, self.size as u32)?;
        let path = t.key.path();
        let u32s: Vec<u8> = t.owner.iter().flat_map(|v| v.to_le_bytes()).collect();
        let f32s: Vec<u8> = t.score.iter().flat_map(|v| v.to_le_bytes()).collect();
        let tile = Obj::new()
            .with("blob", Js::png(blob))
            .with("coverage", Js::u8s(t.coverage.clone()))
            .with("provisional", Js::u8s(t.provisional.clone()))
            .with("quality", Js::u8s(t.quality.clone()))
            .with("conflicts", Js::u8s(t.conflicts.clone()))
            .with("owner", Js::typed(Typed::Uint32, u32s))
            .with("score", Js::typed(Typed::Float32, f32s))
            .with("frozen", Js::u8s(t.frozen.clone()))
            .with("level", t.key.level)
            .with("x", t.key.x)
            .with("y", t.key.y);
        let index = Obj::new()
            .with("canvasId", t.key.canvas.as_str())
            .with("level", t.key.level)
            .with("x", t.key.x)
            .with("y", t.key.y)
            .with("observed", t.observed());
        Ok([
            (format!("tile/{path}"), Js::Obj(tile)),
            (format!("tile-index/{path}"), Js::Obj(index)),
        ])
    }

    /// Stores a dirty tile (resident or evicted) as its two rows.
    pub fn save(&mut self, store: &mut Store, run: &str, t: &Tile) -> Result<(), String> {
        if !t.dirty {
            return Ok(());
        }
        for (k, v) in self.rows(t)? {
            store.put(&format!("{run}{k}"), v);
        }
        Ok(())
    }

    /// Stores a resident tile by id and marks it saved.
    pub fn save_resident(&mut self, store: &mut Store, run: &str, id: u32) -> Result<(), String> {
        let tile = self
            .cache
            .get(id)
            .cloned()
            .ok_or_else(|| format!("CORE_BAD_ARGUMENT: tile {id} is not resident."))?;
        if tile.dirty {
            self.save(store, run, &tile)?;
            self.cache.saved(id);
        }
        Ok(())
    }

    /// Brings a tile into the cache: evicts until there is room, then loads its stored copy, if any. A victim is
    /// stored while still resident and only then let go, so a failed store leaves it cached and dirty (and the new
    /// tile is not brought in), as the page's `TileStore.load` does.
    pub fn load(&mut self, store: &mut Store, run: &str, key: TileKey) -> Result<u32, String> {
        while let Some(victim) = self.cache.victim() {
            self.save_resident(store, run, victim)?;
            self.cache.evict(victim);
        }
        let stored = match store.get(&format!("{run}tile/{}", key.path())) {
            Some(Js::Obj(row)) => {
                let blob = row
                    .get("blob")
                    .and_then(Js::bytes)
                    .ok_or("tile without pixels")?;
                let (w, h, pixels) = decode_png(blob)?;
                if w as usize != self.size || h as usize != self.size {
                    return Err(format!(
                        "Stored tile is {w}×{h}; expected {}×{}.",
                        self.size, self.size
                    ));
                }
                let plane = |name: &str| row.get(name).and_then(Js::bytes).map(|b| b.to_vec());
                Some(StoredTile {
                    pixels,
                    coverage: plane("coverage"),
                    provisional: plane("provisional"),
                    quality: plane("quality"),
                    conflicts: plane("conflicts"),
                    owner: plane("owner").map(|b| le_u32(&b)),
                    score: plane("score").map(|b| le_f32(&b)),
                    frozen: plane("frozen"),
                })
            }
            _ => None,
        };
        self.cache.insert(key, stored).map_err(|e| format!("{e:?}"))
    }

    /// Stores the dirty resident tiles (with `settled_before`, only those last written before it).
    pub fn flush(
        &mut self,
        store: &mut Store,
        run: &str,
        settled_before: Option<f64>,
    ) -> Result<(), String> {
        let ids = self.cache.dirty(settled_before);
        let mut rows = Vec::new();
        for &id in &ids {
            let tile = self.cache.get(id).cloned().unwrap();
            rows.extend(self.rows(&tile)?);
        }
        for (k, v) in rows {
            store.put(&format!("{run}{k}"), v);
        }
        for id in ids {
            self.cache.saved(id);
        }
        Ok(())
    }

    /// Flushes, then drops every resident tile.
    pub fn clear(&mut self, store: &mut Store, run: &str) -> Result<(), String> {
        self.flush(store, run, None)?;
        self.cache.clear();
        Ok(())
    }
}
