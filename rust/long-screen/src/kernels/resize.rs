//! Bounded-memory area downsampling for the user's exported copy. Reconstruction tiles stay native size.

/// Separable box filter with exact integer footprint boundaries. Each call consumes one native RGBA row and
/// emits at most one output row (downsampling only). Storage is O(output width), independent of image height.
/// RGB is accumulated with premultiplied alpha so unobserved holes cannot darken nearby text or add color.
/// General image-resize libraries require a resident source image; this row interface keeps arbitrarily long
/// exports on the same bounded-memory path as the native PNG writer.
pub struct Resize {
    width: usize,
    height: usize,
    output_width: usize,
    output_height: usize,
    input_y: usize,
    output_y: usize,
    horizontal: Vec<[f64; 4]>,
    accumulated: Vec<[f64; 4]>,
}

impl Resize {
    pub fn new(
        width: usize,
        height: usize,
        output_width: usize,
        output_height: usize,
    ) -> Option<Self> {
        if width == 0
            || height == 0
            || output_width == 0
            || output_height == 0
            || output_width > width
            || output_height > height
            || width > i32::MAX as usize
            || height > i32::MAX as usize
        {
            return None;
        }
        Some(Self {
            width,
            height,
            output_width,
            output_height,
            input_y: 0,
            output_y: 0,
            horizontal: vec![[0.0; 4]; output_width],
            accumulated: vec![[0.0; 4]; output_width],
        })
    }

    pub fn input_bytes(&self) -> usize {
        self.width * 4
    }
    pub fn output_bytes(&self) -> usize {
        self.output_width * 4
    }

    /// Returns true when `out` contains the next complete row. Invalid buffers leave the session untouched.
    pub fn push(&mut self, rgba: &[u8], out: &mut [u8]) -> Result<bool, &'static str> {
        if rgba.len() != self.input_bytes()
            || out.len() != self.output_bytes()
            || self.input_y >= self.height
        {
            return Err("Invalid resize row");
        }
        let width = self.width as u64;
        let output_width = self.output_width as u64;
        for (x, pixel) in self.horizontal.iter_mut().enumerate() {
            *pixel = [0.0; 4];
            let left = x as u64 * width;
            let right = left + width;
            for sx in left / output_width..right.div_ceil(output_width) {
                let weight =
                    (right.min((sx + 1) * output_width) - left.max(sx * output_width)) as f64;
                let source = &rgba[sx as usize * 4..sx as usize * 4 + 4];
                let alpha = source[3] as f64 * weight;
                for channel in 0..3 {
                    pixel[channel] += source[channel] as f64 * alpha;
                }
                pixel[3] += alpha;
            }
        }
        // Coordinates measured in output-height units keep every row boundary exact, including odd sizes.
        let top = self.input_y as u64 * self.output_height as u64;
        let bottom = top + self.output_height as u64;
        let boundary = (self.output_y as u64 + 1) * self.height as u64;
        self.accumulate((bottom.min(boundary) - top) as f64);
        self.input_y += 1;
        if bottom < boundary {
            return Ok(false);
        }

        let area = self.width as f64 * self.height as f64;
        for (pixel, sum) in out.chunks_exact_mut(4).zip(&mut self.accumulated) {
            pixel.fill(0);
            pixel[3] = (sum[3] / area).round() as u8;
            if pixel[3] != 0 {
                for channel in 0..3 {
                    pixel[channel] = (sum[channel] / sum[3]).round() as u8;
                }
            }
            *sum = [0.0; 4];
        }
        self.output_y += 1;
        if bottom > boundary {
            self.accumulate((bottom - boundary) as f64);
        }
        Ok(true)
    }

    fn accumulate(&mut self, weight: f64) {
        for (sum, row) in self.accumulated.iter_mut().zip(&self.horizontal) {
            for channel in 0..4 {
                sum[channel] += row[channel] * weight;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resized(width: usize, height: usize, w: usize, h: usize, pixels: &[u8]) -> Vec<u8> {
        let mut resize = Resize::new(width, height, w, h).unwrap();
        let mut row = vec![0; w * 4];
        let mut out = Vec::new();
        for input in pixels.chunks_exact(width * 4) {
            if resize.push(input, &mut row).unwrap() {
                out.extend_from_slice(&row);
            }
        }
        assert_eq!(out.len(), w * h * 4);
        out
    }

    #[test]
    fn fractional_footprints_include_every_edge_without_row_drift() {
        let pixels: Vec<u8> = (0..3)
            .flat_map(|y| (0..3).flat_map(move |x| [(x + y) * 60, 0, 0, 255]))
            .collect();
        assert_eq!(
            resized(3, 3, 2, 2, &pixels),
            [40, 0, 0, 255, 120, 0, 0, 255, 120, 0, 0, 255, 200, 0, 0, 255]
        );
    }

    #[test]
    fn thin_details_are_averaged_instead_of_skipped() {
        let pixels: Vec<u8> = (0..16)
            .flat_map(|i| {
                let v = if i % 2 == 0 { 0 } else { 255 };
                [v, v, v, 255]
            })
            .collect();
        assert_eq!(resized(4, 4, 1, 1, &pixels), [128, 128, 128, 255]);
    }

    #[test]
    fn transparency_does_not_add_dark_or_colored_fringes() {
        assert_eq!(
            resized(2, 1, 1, 1, &[255, 0, 0, 255, 0, 0, 255, 0]),
            [255, 0, 0, 128]
        );
        assert_eq!(
            resized(2, 1, 1, 1, &[99, 20, 80, 0, 0, 0, 0, 0]),
            [0, 0, 0, 0]
        );
    }

    #[test]
    fn very_long_prints_need_only_row_sized_working_buffers() {
        let mut resize = Resize::new(1, 40001, 1, 1).unwrap();
        let mut out = [0; 4];
        for y in 0..40001 {
            assert_eq!(
                resize.push(&[17, 91, 203, 255], &mut out).unwrap(),
                y == 40000
            );
        }
        assert_eq!(out, [17, 91, 203, 255]);
        assert!(resize.push(&[0; 4], &mut out).is_err());
    }

    #[test]
    fn rejects_upscaling_empty_dimensions_and_bad_buffers() {
        for dims in [
            (0, 1, 1, 1),
            (1, 0, 1, 1),
            (1, 1, 0, 1),
            (1, 1, 1, 0),
            (2, 2, 3, 1),
            (2, 2, 1, 3),
        ] {
            assert!(Resize::new(dims.0, dims.1, dims.2, dims.3).is_none());
        }
        let mut resize = Resize::new(2, 2, 1, 1).unwrap();
        assert!(resize.push(&[0; 4], &mut [0; 4]).is_err());
        assert!(resize.push(&[0; 8], &mut [0; 3]).is_err());
    }
}
