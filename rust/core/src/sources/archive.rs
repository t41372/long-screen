//! Versioned owners define their schema; Postcard handles serialization and LZ4 handles compression.
//! A single source tile/page has a bounded native footprint, independent of video duration.
use serde::{de::DeserializeOwned, Serialize};

#[cfg(test)]
mod tests {
    use super::*;
    // Persisted source pages must preserve exact bytes and reject truncated/oversized records
    // before allocation; compression is never allowed to change source pixels or model samples.
    #[test]
    fn pages_roundtrip_and_reject_invalid_lengths() {
        let pixels: Vec<u8> = (0..4096).map(|i| (i * 17) as u8).collect();
        let data = encode(&(1u32, &pixels)).unwrap();
        let restored: (u32, Vec<u8>) = decode(&data).unwrap();
        assert_eq!(restored, (1, pixels));
        assert!(decode::<Vec<u8>>(&data[..data.len() / 2]).is_err());
        assert!(decode::<Vec<u8>>(&[0xff; 4]).is_err());
    }
}
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, postcard::Error> {
    let raw = postcard::to_allocvec(value)?;
    Ok(lz4_flex::block::compress_prepend_size(&raw))
}
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, postcard::Error> {
    let (size, _) = lz4_flex::block::uncompressed_size(bytes)
        .map_err(|_| postcard::Error::DeserializeBadEncoding)?;
    if size > 128 * 1024 * 1024 {
        return Err(postcard::Error::DeserializeBadEncoding);
    }
    let raw = lz4_flex::block::decompress_size_prepended(bytes)
        .map_err(|_| postcard::Error::DeserializeBadEncoding)?;
    postcard::from_bytes(&raw)
}
