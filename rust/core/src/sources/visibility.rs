//! Postcard encodes each of our unit variants as one byte. Reading that plane through serde_bytes
//! avoids a separate enum deserializer per pixel while retaining the original archive format.
use super::Visibility;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn serialize<S: Serializer>(values: &[Visibility], serializer: S) -> Result<S::Ok, S::Error> {
    if serializer.is_human_readable() {
        return values.serialize(serializer);
    }
    let bytes: Vec<u8> = values.iter().map(|v| *v as u8).collect();
    serializer.serialize_bytes(&bytes)
}

pub fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Visibility>, D::Error> {
    if deserializer.is_human_readable() {
        return Vec::<Visibility>::deserialize(deserializer);
    }
    // Borrow the decompressed page during conversion; no second byte plane is allocated.
    let bytes = <&serde_bytes::Bytes>::deserialize(deserializer)?;
    let mut values = Vec::with_capacity(bytes.len());
    for &tag in bytes.iter() {
        use Visibility::*;
        let value = match tag {
            0 => Unknown,
            1 => Visible,
            2 => Occluded,
            3 => Outside,
            4 => PlacementOccluded,
            5 => Context,
            6 => ContextOccluded,
            7 => ContextPlacementOccluded,
            8 => ContextExcluded,
            9 => Background,
            10 => ContextBackground,
            11 => ContextSurface,
            _ => return Err(serde::de::Error::custom("invalid source visibility")),
        };
        values.push(value);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Plane(#[serde(with = "super")] Vec<Visibility>);

    // Every tag, an empty plane, long sequence lengths, invalid tags, and truncated planes must
    // agree with the old enum sequence codec. Human-readable exports must keep their enum names.
    #[test]
    fn bulk_planes_preserve_postcard_bytes_and_json_names() {
        let variants = [
            Visibility::Unknown,
            Visibility::Visible,
            Visibility::Occluded,
            Visibility::Outside,
            Visibility::PlacementOccluded,
            Visibility::Context,
            Visibility::ContextOccluded,
            Visibility::ContextPlacementOccluded,
            Visibility::ContextExcluded,
            Visibility::Background,
            Visibility::ContextBackground,
            Visibility::ContextSurface,
        ];
        for n in [0, 1, 12, 127, 128, 256, 4096] {
            let values: Vec<_> = (0..n).map(|i| variants[i % variants.len()]).collect();
            let bytes = postcard::to_allocvec(&values).unwrap();
            assert_eq!(
                postcard::to_allocvec(&Plane(values.clone())).unwrap(),
                bytes
            );
            assert_eq!(postcard::from_bytes::<Plane>(&bytes).unwrap().0, values);
            let json = serde_json::to_string(&values).unwrap();
            assert_eq!(serde_json::to_string(&Plane(values.clone())).unwrap(), json);
            assert_eq!(serde_json::from_str::<Plane>(&json).unwrap().0, values);
            if n > 0 {
                assert!(postcard::from_bytes::<Plane>(&bytes[..bytes.len() - 1]).is_err());
            }
        }
        assert!(postcard::from_bytes::<Plane>(&[1, 12]).is_err());
        assert!(postcard::from_bytes::<Plane>(&[1, 255]).is_err());
    }
}
