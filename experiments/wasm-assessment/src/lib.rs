#![no_std]

//! Assessment-only kernels; the production TypeScript is the migration-equivalence oracle.

use core::slice;

const OCCLUSION_WORDS: usize = 4;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline]
unsafe fn read_i32(ptr: *const u8, index: usize) -> i32 {
    let bytes = slice::from_raw_parts(ptr.add(index * 4), 4);
    i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[inline]
unsafe fn read_u32(ptr: *const u8, index: usize) -> u32 {
    read_i32(ptr, index) as u32
}

#[inline]
unsafe fn read_f64(ptr: *const u8, index: usize) -> f64 {
    let bytes = slice::from_raw_parts(ptr.add(index * 8), 8);
    f64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ])
}

#[inline]
fn js_round(value: f64) -> i32 {
    // Adding .5 first can round a value immediately below a half-integer the wrong way.
    let floor = js_floor(value);
    floor + if value - floor as f64 >= 0.5 { 1 } else { 0 }
}

#[inline]
fn js_floor(value: f64) -> i32 {
    let truncated = value as i32;
    if value < truncated as f64 {
        truncated.saturating_sub(1)
    } else {
        truncated
    }
}

#[inline]
fn js_ceil(value: f64) -> i32 {
    let truncated = value as i32;
    if value > truncated as f64 {
        truncated.saturating_add(1)
    } else {
        truncated
    }
}

#[inline]
unsafe fn vote_verdict(vote: *const u8, x: i32, y: i32, factor: i32) -> i32 {
    if vote.is_null() {
        return 0;
    }
    // Vote descriptor: x0, y0, w, h, bits_ptr, bits_len, clean_ptr, clean_len (i32 words).
    let x0 = read_i32(vote, 0);
    let y0 = read_i32(vote, 1);
    let width = read_i32(vote, 2);
    let height = read_i32(vote, 3);
    let bits_len = read_i32(vote, 5).max(0) as usize;
    let clean_len = read_i32(vote, 7).max(0) as usize;
    let lx = x.div_euclid(factor) - x0;
    let ly = y.div_euclid(factor) - y0;
    if width <= 0 || height <= 0 || lx < 0 || ly < 0 || lx >= width || ly >= height {
        return 0;
    }
    let index = (ly * width + lx) as usize;
    let bit = 1u8 << (index & 7);
    let bits = read_u32(vote, 4) as *const u8;
    let clean = read_u32(vote, 6) as *const u8;
    if !bits.is_null() && index >> 3 < bits_len && *bits.add(index >> 3) & bit != 0 {
        -1
    } else if !clean.is_null() && index >> 3 < clean_len && *clean.add(index >> 3) & bit != 0 {
        1
    } else {
        0
    }
}

#[inline]
unsafe fn occluded(occlusions: *const u8, count: i32, x: i32, y: i32) -> bool {
    if occlusions.is_null() {
        return false;
    }
    for index in 0..count.max(0) as usize {
        let offset = index * OCCLUSION_WORDS;
        // Occlusion data is four little-endian f64 values: x, y, width, height.
        let ox = read_f64(occlusions, offset);
        let oy = read_f64(occlusions, offset + 1);
        let ow = read_f64(occlusions, offset + 2);
        let oh = read_f64(occlusions, offset + 3);
        let fx = x as f64;
        let fy = y as f64;
        if fx >= ox && fy >= oy && fx < ox + ow && fy < oy + oh {
            return true;
        }
    }
    false
}

/// Run the current Engine.consistencyMask truth table over one native RGBA frame.
///
/// All buffers are caller-owned WASM linear-memory pointers. `prev_ptr`/`next_ptr` and vote
/// descriptors are zero for absent or different-canvas neighbours. A vote descriptor is eight
/// i32 words: x0, y0, w, h, bits_ptr, bits_len, clean_ptr, clean_len. Occlusions are four f64
/// values per rectangle. The output is initialized to 1, including pixels outside the region.
///
/// # Safety
/// The trusted benchmark caller supplies finite, bounded coordinates, valid disjoint buffers,
/// image/label/output lengths matching width × height, and complete vote bitsets.
#[no_mangle]
pub unsafe extern "C" fn consistency_mask(
    image_ptr: u32,
    labels_ptr: u32,
    prev_ptr: u32,
    next_ptr: u32,
    prev_enabled: u32,
    next_enabled: u32,
    output_ptr: u32,
    width: u32,
    height: u32,
    region_x: f64,
    region_y: f64,
    region_width: f64,
    region_height: f64,
    code: u8,
    pose_x: f64,
    pose_y: f64,
    prev_pose_x: f64,
    prev_pose_y: f64,
    next_pose_x: f64,
    next_pose_y: f64,
    prev_occlusions_ptr: u32,
    prev_occlusions_count: u32,
    next_occlusions_ptr: u32,
    next_occlusions_count: u32,
    current_vote_ptr: u32,
    prev_vote_ptr: u32,
    next_vote_ptr: u32,
    factor: u32,
    noise: f64,
) {
    let pixels = (width as usize).saturating_mul(height as usize);
    let image = image_ptr as *const u8;
    let labels = labels_ptr as *const u8;
    let output = output_ptr as *mut u8;
    let prev = if prev_enabled != 0 {
        prev_ptr as *const u8
    } else {
        core::ptr::null()
    };
    let next = if next_enabled != 0 {
        next_ptr as *const u8
    } else {
        core::ptr::null()
    };
    let factor = factor.max(1) as i32;

    for index in 0..pixels {
        *output.add(index) = 1;
    }
    if width == 0 || height == 0 {
        return;
    }

    let rx0 = js_floor(region_x).max(0).min(width as i32);
    let ry0 = js_floor(region_y).max(0).min(height as i32);
    let rx1 = js_ceil(region_x + region_width).max(0).min(width as i32);
    let ry1 = js_ceil(region_y + region_height).max(0).min(height as i32);
    let current_raster_x = js_round(pose_x);
    let current_raster_y = js_round(pose_y);
    let prev_raster_x = js_round(prev_pose_x);
    let prev_raster_y = js_round(prev_pose_y);
    let next_raster_x = js_round(next_pose_x);
    let next_raster_y = js_round(next_pose_y);

    for sy in ry0..ry1 {
        for sx in rx0..rx1 {
            let source = (sy * width as i32 + sx) as usize;
            if *labels.add(source) != code {
                continue;
            }
            if vote_verdict(current_vote_ptr as *const u8, sx, sy, factor) < 0 {
                *output.add(source) = 0;
                continue;
            }
            let image_offset = source * 4;
            let red = *image.add(image_offset);
            let green = *image.add(image_offset + 1);
            let blue = *image.add(image_offset + 2);
            let mut checked = 0i32;
            let mut condemned = 0i32;
            let mut excused = 0i32;

            if !prev.is_null() {
                compare_neighbour(
                    labels,
                    width,
                    height,
                    sx,
                    sy,
                    red,
                    green,
                    blue,
                    current_raster_x,
                    current_raster_y,
                    prev,
                    prev_raster_x,
                    prev_raster_y,
                    prev_occlusions_ptr as *const u8,
                    prev_occlusions_count as i32,
                    prev_vote_ptr as *const u8,
                    factor,
                    noise,
                    code,
                    &mut checked,
                    &mut condemned,
                    &mut excused,
                );
            }
            if condemned == 0 && !next.is_null() {
                compare_neighbour(
                    labels,
                    width,
                    height,
                    sx,
                    sy,
                    red,
                    green,
                    blue,
                    current_raster_x,
                    current_raster_y,
                    next,
                    next_raster_x,
                    next_raster_y,
                    next_occlusions_ptr as *const u8,
                    next_occlusions_count as i32,
                    next_vote_ptr as *const u8,
                    factor,
                    noise,
                    code,
                    &mut checked,
                    &mut condemned,
                    &mut excused,
                );
            }
            if condemned != 0 || (excused != 0 && checked >= 2) {
                *output.add(source) = 0;
            }
        }
    }
}

#[inline]
#[allow(clippy::too_many_arguments)]
unsafe fn compare_neighbour(
    labels: *const u8,
    width: u32,
    height: u32,
    sx: i32,
    sy: i32,
    red: u8,
    green: u8,
    blue: u8,
    current_raster_x: i32,
    current_raster_y: i32,
    neighbour: *const u8,
    neighbour_raster_x: i32,
    neighbour_raster_y: i32,
    occlusions: *const u8,
    occlusions_count: i32,
    vote: *const u8,
    factor: i32,
    noise: f64,
    code: u8,
    checked: &mut i32,
    condemned: &mut i32,
    excused: &mut i32,
) {
    let ix = sx + current_raster_x - neighbour_raster_x;
    let iy = sy + current_raster_y - neighbour_raster_y;
    if ix < 0 || iy < 0 || ix >= width as i32 || iy >= height as i32 {
        return;
    }
    let neighbour_source = (iy * width as i32 + ix) as usize;
    if *labels.add(neighbour_source) != code || occluded(occlusions, occlusions_count, ix, iy) {
        return;
    }
    *checked += 1;
    let offset = neighbour_source * 4;
    let nr = *neighbour.add(offset);
    let ng = *neighbour.add(offset + 1);
    let nb = *neighbour.add(offset + 2);
    if red == nr && green == ng && blue == nb {
        return;
    }
    let difference =
        ((red.abs_diff(nr) as u32 + green.abs_diff(ng) as u32 + blue.abs_diff(nb) as u32) as f64)
            / 3.0;
    if difference <= noise {
        return;
    }
    if vote_verdict(vote, ix, iy, factor) < 0 {
        *excused += 1;
    } else {
        *condemned += 1;
    }
}

/// Box-filtered luma matching src/core/raster.ts::downscaleGray.
///
/// # Safety
/// Input is width × height × 4 bytes, output holds ceil(width/factor) × ceil(height/factor)
/// bytes, the buffers do not overlap, and dimensions and factor are positive and bounded.
#[no_mangle]
pub unsafe extern "C" fn downscale_gray(
    image_ptr: u32,
    output_ptr: u32,
    width: u32,
    height: u32,
    factor: u32,
) {
    let factor = factor.max(1);
    let output_width = (width.saturating_add(factor - 1) / factor).max(1);
    let output_height = (height.saturating_add(factor - 1) / factor).max(1);
    let image = image_ptr as *const u8;
    let output = output_ptr as *mut u8;
    for y in 0..output_height {
        for x in 0..output_width {
            let bw = factor.min(width.saturating_sub(x * factor));
            let bh = factor.min(height.saturating_sub(y * factor));
            let mut sum = 0u64;
            for row in 0..bh {
                let start = ((y * factor + row) * width + x * factor) as usize * 4;
                for column in 0..bw {
                    let index = start + column as usize * 4;
                    sum += *image.add(index) as u64 * 77;
                    sum += *image.add(index + 1) as u64 * 150;
                    sum += *image.add(index + 2) as u64 * 29;
                }
            }
            let area = (bw * bh).max(1) as u64;
            *output.add((y * output_width + x) as usize) = ((sum / area) >> 8) as u8;
        }
    }
}
