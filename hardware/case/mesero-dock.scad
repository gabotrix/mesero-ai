// =============================================================================
// Mesero AI — table dock for reSpeaker XVF3800 + XIAO ESP32S3
//
// A plain cylinder the size of the board, with a small cradle on top that a
// phone leans into. Nothing else: no rear lobe, no slots, no pockets.
//
// Dimensions are from the Seeed datasheets, not estimated:
//   reSpeaker XVF3800 + XIAO   102 x 102 x 10 mm  (a 102 mm circle, boxed)
//   Microphone circle           66 mm
//   Speaker 114993346           50 x 45 x 22 mm
//
//   openscad -D 'part="base"'  -o base.stl  mesero-dock.scad
//   openscad -D 'part="lid"'   -o lid.stl   mesero-dock.scad
//   openscad -D 'part="calib"' -o calib.stl mesero-dock.scad
// =============================================================================

part = "base";   // "base" | "lid" | "calib" | "preview"

/* [Board — from the datasheet] ============================================= */

board_dia   = 102;
board_bay_h = 15;    // headroom for the board and its connectors
mic_circle  = 66;

// Not published anywhere. Verify with the coupon before printing the lid.
mount_hole_dia    = 2.6;   // VERIFY
mount_circle_dia  = 90;    // VERIFY
mount_first_angle = 45;    // VERIFY

/* [Speaker — from the datasheet] =========================================== */

speaker_l = 50;
speaker_w = 45;
speaker_h = 22;

/* [Microphone ports and LED ring] ========================================== */

mic_band_inner = mic_circle - 10;
mic_band_outer = mic_circle + 10;
mic_hole_dia   = 1.8;
mic_hole_rings = 3;
mic_holes_per_ring = 40;

led_slot_inner = 30;
led_slot_outer = 42;
led_membrane   = 0;      // 0 = open slot, 0.6 = printed diffuser

/* [Phone cradle] =========================================================== */

// A backrest and a lip standing on the lid. The phone leans back against the
// rest and gravity holds it. Placed toward the rim so the phone's lower edge
// covers as little of the microphone band as it can.
cradle_h     = 30;    // backrest height
cradle_lean  = 14;    // degrees off vertical, leaning away from the diner
cradle_gap   = 15;    // phone plus case
cradle_lip_h = 9;
cradle_t     = 3.2;   // wall thickness at the top
cradle_root  = 3.0;   // extra thickness at the root, where it wants to snap

// NTAG213, 25 mm round, right under where the phone's lower edge lands.
nfc_dia   = 27;
nfc_depth = 1.2;

/* [Maker's mark] =========================================================== */

// The GABOTRIX wordmark, sunk into the front wall so it can be filled by hand
// after printing — paint, resin or a scrap of filament pressed in warm.
//
// It is wrapped around the cylinder rather than projected flat onto it. A flat
// pocket cannot work here: a 40 mm chord on this 53.75 mm radius drops 3.9 mm
// away from the surface at its ends, and the wall is only 2.4 mm thick, so a
// flat-bottomed recess would cut straight through. Wrapping keeps the depth
// constant everywhere.
logo_file   = "gabotrix-logo.svg";
logo_aspect = 7.131;   // from the traced outline; height follows the width
logo_w      = 40;      // arc length along the wall
logo_z      = 8.5;     // height of its centre above the table
logo_depth  = 0.8;     // leaves 1.6 mm of wall behind it
logo_angle  = 90;      // 90 = facing the diner; the cable exit is at the back
logo_slices = 60;      // strips used to bend it; 60 puts the error under 1 µm

/* [Enclosure] ============================================================== */

wall     = 2.4;
floor_h  = 2.4;
fit      = 0.35;
screw_dia = 3.2;
screw_head_dia = 6.2;
boss_dia = 8;

$fn = 120;

// ----------------------------------------------------------------- derived

outer_dia = board_dia + 2 * wall + 2 * fit;   // 107.5
outer_r   = outer_dia / 2;
base_h    = floor_h + speaker_h + 3;
lid_h     = board_bay_h + wall;


module screw_positions() {
    for (i = [0 : 3])
        rotate([0, 0, mount_first_angle + i * 90])
            translate([mount_circle_dia / 2, 0, 0])
                children();
}

// ------------------------------------------------------------ acoustics

/// A perforated band centred on the 66 mm circle the datasheet gives, wide
/// enough that a couple of millimetres of placement error still finds open air.
module mic_ports() {
    step = (mic_band_outer - mic_band_inner) / 2 / max(mic_hole_rings - 1, 1);
    for (r = [0 : mic_hole_rings - 1]) {
        rad = mic_band_inner / 2 + r * step;
        off = (r % 2) * (180 / mic_holes_per_ring);
        for (a = [0 : 360 / mic_holes_per_ring : 359.9])
            // Skip the sector the cradle stands on. A hole under the backrest is
            // a hole into solid plastic, and drilling it only weakened the join.
            if (rad * sin(a + off) > -(outer_r - 16) + 4)
                rotate([0, 0, a + off])
                    translate([rad, 0, -1])
                        // Plate thickness only. Running these the full height
                        // drilled straight through the cradle above.
                        cylinder(d = mic_hole_dia, h = wall + 2);
    }
}

/// Slots in the floor under the driver. Vented rather than sealed: a 5 W driver
/// in a sealed box this size sounds thin, and open-backed it cancels itself.
module speaker_vents() {
    for (i = [-2 : 2])
        translate([i * 9, 0, -1])
            cube([4.5, speaker_w - 12, floor_h + 2], center = true);
}

/**
 * The wordmark, bent onto the wall.
 *
 * OpenSCAD cannot deform a solid, so the outline is sliced into thin vertical
 * strips and each strip is stood up at its own angle on the cylinder. Every
 * strip is cut radially, which is what makes the depth uniform — the thing a
 * flat projection gets wrong.
 */
module logo_recess() {
    if (logo_w > 0) {
    logo_h = logo_w / logo_aspect;
    step   = logo_w / logo_slices;
    r      = outer_r;

    translate([0, 0, logo_z])
        rotate([0, 0, logo_angle])
            for (i = [0 : logo_slices - 1]) {
                cx  = -logo_w / 2 + (i + 0.5) * step;
                ang = cx / r * 180 / PI;
                rotate([0, 0, ang])
                    // Start the cut inside the wall and run it past the surface,
                    // so the recess opens cleanly instead of leaving a skin.
                    translate([r - logo_depth, 0, 0])
                        rotate([90, 0, 90])
                            linear_extrude(height = logo_depth + 0.6)
                                translate([-cx, 0])
                                    intersection() {
                                        translate([-logo_w / 2, -logo_h / 2])
                                            resize([logo_w, logo_h])
                                                import(logo_file);
                                        translate([cx, 0])
                                            square([step * 1.02, logo_h * 2], center = true);
                                    }
            }
    }
}

// ---------------------------------------------------------------- parts

module base() {
    difference() {
        cylinder(d = outer_dia, h = base_h);

        // Speaker bay.
        translate([-(speaker_l + fit * 2) / 2, -(speaker_w + fit * 2) / 2, floor_h])
            cube([speaker_l + fit * 2, speaker_w + fit * 2, speaker_h + 6]);

        speaker_vents();

        // Cable exit at the back.
        translate([-9, -outer_r - 1, floor_h + 3])
            cube([18, wall + 4, 10]);

        // Screw pilots.
        translate([0, 0, base_h - 14])
            screw_positions() cylinder(d = screw_dia - 0.6, h = 16);

        logo_recess();

        // Feet.
        for (a = [30 : 120 : 359])
            rotate([0, 0, a])
                translate([outer_r - 13, 0, -0.01])
                    cylinder(d = 13, h = 1.1);
    }

    // Bosses carrying the lid screws.
    difference() {
        translate([0, 0, base_h - 14])
            screw_positions() cylinder(d = boss_dia, h = 14);
        translate([0, 0, base_h - 14.5])
            screw_positions() cylinder(d = screw_dia - 0.6, h = 16);
    }
}

/**
 * Backrest and lip.
 *
 * The contact face is flat, because a phone is flat: an arc following the rim
 * looked right and was useless — a flat phone touches a concave wall only at its
 * two edges and rocks between them.
 *
 * Strength comes from how it is attached instead of from its shape. The wall
 * spans a chord and is intersected with the body, so both of its ends merge into
 * the case rim: a beam held at both ends rather than a plate cantilevered off
 * the lid, which is what snaps. Its section runs thick at the root and thin at
 * the lip, putting material where the bending moment actually is.
 */
module phone_cradle() {
    lean = cradle_h * tan(cradle_lean);
    y0   = -(outer_r - 16);          // front face of the backrest, at the base
    yl   = y0 + cradle_gap;          // where the lip stands

    intersection() {
        union() {
            // Backrest: a straight wall, leaning away from the diner, thicker at
            // the root than at the top.
            rotate([90, 0, 90])
                linear_extrude(outer_dia + 10, center = true)
                    polygon([
                        [y0,                      0],
                        [y0 - cradle_root - cradle_t, 0],
                        [y0 - lean - cradle_t,    cradle_h],
                        [y0 - lean,               cradle_h],
                    ]);

            // Lip the phone stands on.
            rotate([90, 0, 90])
                linear_extrude(outer_dia + 10, center = true)
                    polygon([
                        [yl,            0],
                        [yl + cradle_t, 0],
                        [yl + cradle_t, cradle_lip_h],
                        [yl,            cradle_lip_h],
                    ]);
        }

        // Both ends run into the rim, and nothing overhangs the footprint.
        cylinder(d = outer_dia, h = cradle_h * 3);
    }
}

module lid() {
    difference() {
        union() {
            cylinder(d = outer_dia, h = wall);

            // Skirt over the board bay.
            translate([0, 0, -lid_h])
                difference() {
                    cylinder(d = outer_dia, h = lid_h);
                    translate([0, 0, -1])
                        cylinder(d = outer_dia - 2 * wall, h = lid_h + 2);
                }

            // Shelf the board rests on.
            translate([0, 0, -board_bay_h])
                difference() {
                    cylinder(d = board_dia + 2 * wall, h = 2.4);
                    translate([0, 0, -1]) cylinder(d = board_dia - 6, h = 5);
                }

            phone_cradle();
        }

        mic_ports();

        // Light slot for the 12-LED ring.
        translate([0, 0, led_membrane - 0.01])
            difference() {
                cylinder(d = led_slot_outer, h = wall + 2);
                translate([0, 0, -1]) cylinder(d = led_slot_inner, h = wall + 4);
            }

        // NFC pocket, opened from underneath so it is invisible in use.
        translate([0, -(outer_r - 16) + cradle_gap / 2, -0.01])
            cylinder(d = nfc_dia, h = nfc_depth);

        screw_positions() {
            translate([0, 0, -lid_h - 1]) cylinder(d = screw_dia, h = lid_h + wall + 2);
            translate([0, 0, wall - 1.7])
                cylinder(d1 = screw_dia, d2 = screw_head_dia, h = 1.8);
        }

        // Connector cutouts through the skirt. These angles are placed, not
        // measured — check them against the board before printing.
        rotate([0, 0, 150]) port_cut(12, 6);   // USB-C, base board
        rotate([0, 0, 178]) port_cut(9, 9);    // 3.5 mm jack
        rotate([0, 0, 40])  port_cut(12, 6);   // USB-C, XIAO
        rotate([0, 0, 330]) port_cut(11, 7);   // speaker JST
    }
}

module port_cut(w, h) {
    translate([-w / 2, outer_dia / 2 - wall - 1.5, -board_bay_h + 2])
        cube([w, wall * 3 + 3, h]);
}

/// Ten-minute coupon: the board seat and the screw circle, nothing else.
///
/// Thin the coupon by removing floor, never by cutting sectors. Three sector
/// cuts used to hollow it out, and every one of the four screw positions fell
/// inside one — the gauge came out with no holes in it at all, which is the
/// one thing it exists to measure.
calib_pad = 18;   // square tab centred on each screw

module calib() {
    difference() {
        union() {
            // The seat wall, kept whole: it checks the board diameter and
            // holds the four tabs at their true relative positions.
            difference() {
                cylinder(d = board_dia + 2 * wall + 2 * fit, h = 9);
                translate([0, 0, -1]) cylinder(d = board_dia + fit, h = 11);
            }
            // Floor only where a screw lands, tied back into the wall.
            intersection() {
                cylinder(d = board_dia + 2 * wall + 2 * fit, h = 3);
                union()
                    screw_positions()
                        translate([-calib_pad / 2, -calib_pad / 2, 0])
                            cube([calib_pad, calib_pad, 3]);
            }
        }
        screw_positions()
            translate([0, 0, -1]) cylinder(d = mount_hole_dia, h = 14);
    }
}

// ---------------------------------------------------------------------------

if (part == "base")       base();
else if (part == "lid")   lid();
else if (part == "calib") calib();
else {
    base();
    translate([0, 0, base_h + lid_h + 6]) lid();
}
