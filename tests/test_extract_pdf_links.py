import unittest

import pymupdf

from scripts.extract_pdf_links import build_events, context_at, is_generic, page_grid, table_row_detail


class LinkedTableMappingTests(unittest.TestCase):
    def setUp(self):
        self.doc = pymupdf.open()
        self.page = self.doc.new_page(width=820, height=220)
        for y in (40, 80, 110, 150, 190):
            self.page.draw_line((20, y), (800, y))
        for x in (20, 100, 120, 700, 800):
            self.page.draw_line((x, 40), (x, 190))
        for x in (120.6, 700.6):
            self.page.draw_line((x, 40), (x, 190))

        self.lines = [
            {"text": "Group", "x0": 24, "y0": 50, "x1": 75, "y1": 62},
            {"text": "No.", "x0": 88, "y0": 50, "x1": 108, "y1": 62},
            {"text": "Service title", "x0": 120, "y0": 50, "x1": 210, "y1": 62},
            {"text": "Action method", "x0": 710, "y0": 50, "x1": 790, "y1": 62},
            {"text": "SFF", "x0": 24, "y0": 84, "x1": 50, "y1": 96},
            {"text": "1", "x0": 88, "y0": 84, "x1": 96, "y1": 96},
            {"text": "Change SIM (ไม่รวมการสมัคร eSIM)", "x0": 120, "y0": 84, "x1": 380, "y1": 96},
            {"text": "Customer Contract Profile (Break,", "x0": 120, "y0": 114, "x1": 410, "y1": 126},
            {"text": "Empowerment Break, Rollback, Move)", "x0": 120, "y0": 128, "x1": 430, "y1": 140},
            {"text": "Check Usage Detail", "x0": 120, "y0": 157, "x1": 260, "y1": 169},
        ]
        self.grid = page_grid(self.page)

    def tearDown(self):
        self.doc.close()

    def make_link(self, y, x=745):
        return {"x": x, "x1": x + 40, "y": y - 5, "y1": y + 5, "all_lines": self.lines}

    def test_maps_action_links_to_menu_text_in_the_same_table_row(self):
        self.assertEqual(
            table_row_detail(self.make_link(95), self.grid),
            "Change SIM (ไม่รวมการสมัคร eSIM)",
        )
        self.assertEqual(
            table_row_detail(self.make_link(130), self.grid),
            "Customer Contract Profile (Break, Empowerment Break, Rollback, Move)",
        )
        self.assertEqual(
            table_row_detail(self.make_link(170), self.grid),
            "Check Usage Detail",
        )

    def test_ignores_links_outside_the_action_column(self):
        self.assertIsNone(table_row_detail(self.make_link(95, x=500), self.grid))

    def test_recognizes_repeated_generic_action_text(self):
        self.assertTrue(is_generic("คลิก คลิก"))
        self.assertTrue(is_generic("click here click here"))
        self.assertFalse(is_generic("Click for details"))

    def test_centered_grid_heading_sets_context_without_promoting_link_text(self):
        doc = pymupdf.open()
        page = doc.new_page(width=820, height=220)
        for y in (40, 80, 130):
            page.draw_line((20, y), (800, y))

        heading = "Tools and menus"
        heading_x = (page.rect.width - pymupdf.get_text_length(heading, fontname="hebo", fontsize=12)) / 2
        page.insert_text((heading_x, 66), heading, fontname="hebo", fontsize=12)
        link_label = "Menu Item"
        link_x = (page.rect.width - pymupdf.get_text_length(link_label, fontname="hebo", fontsize=12)) / 2
        page.insert_text((link_x, 111), link_label, fontname="hebo", fontsize=12)
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(360, 95, 460, 118),
                          "uri": "https://example.com"})

        self.assertEqual(context_at(build_events(doc), 1, 140), (heading, ""))
        doc.close()


if __name__ == "__main__":
    unittest.main()