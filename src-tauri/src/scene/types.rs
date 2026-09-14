use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCENE_SCHEMA: &str = "tfsb.vector-scene-v1";
pub const SCENE_COMPATIBILITY: u32 = 1;
pub const SCENE_COMPILER_LEVEL: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProfile {
    Illustration,
    Diagram,
    Editorial,
    Promotional,
    Pattern,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtboardPolicy {
    Contain,
    Pad,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artboard {
    pub width: f64,
    pub height: f64,
    pub view_box: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<ArtboardPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Paint {
    None,
    CurrentColor,
    Solid {
        color: String,
    },
    Token {
        name: String,
    },
    Gradient {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        fallback: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StrokeLinecap {
    Butt,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StrokeLinejoin {
    Miter,
    Round,
    Bevel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FillRule {
    Nonzero,
    Evenodd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClipRule {
    Nonzero,
    Evenodd,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Paint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_dasharray: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_dashoffset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_linecap: Option<StrokeLinecap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_linejoin: Option<StrokeLinejoin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_miterlimit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_rule: Option<FillRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip_rule: Option<ClipRule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aria_hidden: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TransformOperation {
    Translate {
        x: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    Scale {
        x: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    Rotate {
        angle: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cx: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cy: Option<f64>,
    },
    Matrix {
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        e: f64,
        f: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GradientStop {
    pub offset: f64,
    pub color: Paint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GradientUnits {
    UserSpaceOnUse,
    ObjectBoundingBox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpreadMethod {
    Pad,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GradientDef {
    LinearGradient {
        id: String,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        gradient_units: Option<GradientUnits>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spread_method: Option<SpreadMethod>,
        stops: Vec<GradientStop>,
    },
    RadialGradient {
        id: String,
        cx: f64,
        cy: f64,
        r: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        fx: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fy: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gradient_units: Option<GradientUnits>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spread_method: Option<SpreadMethod>,
        stops: Vec<GradientStop>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SymbolDef {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub view_box: [f64; 4],
    pub elements: Vec<SceneElement>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneDefinitions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gradients: Option<Vec<GradientDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbols: Option<Vec<SymbolDef>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CardinalAnchor {
    Top,
    Bottom,
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ConnectorEndpoint {
    Point {
        x: f64,
        y: f64,
    },
    ElementAnchor {
        #[serde(rename = "elementId")]
        element_id: String,
        anchor: CardinalAnchor,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArrowheadType {
    None,
    Triangle,
    Chevron,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectorRouting {
    Straight,
    Orthogonal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LabelAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SceneElement {
    Path {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        d: String,
    },
    Rect {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        rx: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ry: Option<f64>,
    },
    Circle {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        cx: f64,
        cy: f64,
        r: f64,
    },
    Ellipse {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    Line {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
    Polyline {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        points: Vec<[f64; 2]>,
    },
    Polygon {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        points: Vec<[f64; 2]>,
    },
    Group {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        children: Vec<SceneElement>,
    },
    Use {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        href: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        width: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        height: Option<f64>,
    },
    DiagramNode {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        rx: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ry: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label_color: Option<Paint>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label_scale: Option<f64>,
    },
    Connector {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        routing: ConnectorRouting,
        from: ConnectorEndpoint,
        to: ConnectorEndpoint,
        #[serde(skip_serializing_if = "Option::is_none")]
        waypoints: Option<Vec<[f64; 2]>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_arrowhead: Option<ArrowheadType>,
        #[serde(skip_serializing_if = "Option::is_none")]
        end_arrowhead: Option<ArrowheadType>,
        #[serde(skip_serializing_if = "Option::is_none")]
        arrowhead_size: Option<f64>,
    },
    Label {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        presentation: Option<Presentation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        transform: Option<Vec<TransformOperation>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bounds: Option<[f64; 4]>,
        text: String,
        x: f64,
        y: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        scale: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<Paint>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line_spacing: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        align: Option<LabelAlign>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlignAxis {
    Left,
    Center,
    Right,
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DistributeAxis {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayoutDirective {
    Align {
        alignment: AlignAxis,
        targets: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        relative_to: Option<String>,
    },
    Distribute {
        axis: DistributeAxis,
        targets: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        spacing: Option<f64>,
    },
    Grid {
        targets: Vec<String>,
        columns: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        column_gap: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        row_gap: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        start_y: Option<f64>,
    },
    Anchor {
        target: String,
        target_anchor: CardinalAnchor,
        relative_to: String,
        relative_to_anchor: CardinalAnchor,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset_x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset_y: Option<f64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SceneAccessibility {
    Labelled {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        desc: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        focusable: Option<bool>,
    },
    Decorative {
        #[serde(skip_serializing_if = "Option::is_none")]
        focusable: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneProvenance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorScene {
    pub schema: String,
    pub compatibility: u32,
    pub compiler_level: u32,
    pub profile: SceneProfile,
    pub artboard: Artboard,
    pub accessibility: SceneAccessibility,
    pub elements: Vec<SceneElement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definitions: Option<SceneDefinitions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_bindings: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<Vec<LayoutDirective>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<SceneProvenance>,
}

impl Default for VectorScene {
    fn default() -> Self {
        Self {
            schema: SCENE_SCHEMA.to_owned(),
            compatibility: SCENE_COMPATIBILITY,
            compiler_level: SCENE_COMPILER_LEVEL,
            profile: SceneProfile::Illustration,
            artboard: Artboard {
                width: 1440.0,
                height: 720.0,
                view_box: [0.0, 0.0, 1440.0, 720.0],
                policy: Some(ArtboardPolicy::Contain),
            },
            accessibility: SceneAccessibility::Decorative { focusable: None },
            elements: vec![SceneElement::Rect {
                id: Some("background".to_owned()),
                presentation: Some(Presentation {
                    fill: Some(Paint::Solid {
                        color: "#f2f0ff".to_owned(),
                    }),
                    ..Presentation::default()
                }),
                transform: None,
                bounds: None,
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 720.0,
                rx: None,
                ry: None,
            }],
            definitions: None,
            token_bindings: None,
            layout: None,
            provenance: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SceneEditOperation {
    SetArtboard {
        artboard: Artboard,
    },
    SetProfile {
        profile: SceneProfile,
    },
    SetAccessibility {
        accessibility: SceneAccessibility,
    },
    InsertElement {
        #[serde(skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
        element: SceneElement,
    },
    UpdateElement {
        id: String,
        element: SceneElement,
    },
    RemoveElement {
        id: String,
    },
    MoveElement {
        id: String,
        new_index: usize,
    },
    SetDefinitions {
        #[serde(skip_serializing_if = "Option::is_none")]
        definitions: Option<SceneDefinitions>,
    },
    SetTokenBindings {
        #[serde(skip_serializing_if = "Option::is_none")]
        token_bindings: Option<BTreeMap<String, String>>,
    },
    SetLayout {
        #[serde(skip_serializing_if = "Option::is_none")]
        layout: Option<Vec<LayoutDirective>>,
    },
    SetProvenance {
        #[serde(skip_serializing_if = "Option::is_none")]
        provenance: Option<SceneProvenance>,
    },
    ReplaceScene {
        scene: VectorScene,
    },
}
