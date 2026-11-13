"""
Unit tests to analytically verify Table III of IEEE Paper
"""

import unittest
from backend.scenario_runner import ScenarioEvaluator

class TestTableIIIScenarios(unittest.TestCase):
    def setUp(self):
        self.runner = ScenarioEvaluator()

    def test_scenario_1_side_road_junction(self):
        res = self.runner.run_scenario("S1")
        steps = res["analytical_steps"]
        self.assertEqual(steps["t_star"], 6.0)
        self.assertEqual(steps["d_min"], 0.0)
        self.assertEqual(steps["d_safe"], 6.5)
        self.assertEqual(steps["computed_decision"], "Warning")

    def test_scenario_2_rear_approach(self):
        res = self.runner.run_scenario("S2")
        steps = res["analytical_steps"]
        self.assertEqual(steps["t_star"], 3.0)
        self.assertEqual(steps["d_min"], 0.0)
        self.assertEqual(steps["d_safe"], 6.5)
        self.assertEqual(steps["computed_decision"], "Critical")

    def test_scenario_3_side_by_side(self):
        res = self.runner.run_scenario("S3")
        steps = res["analytical_steps"]
        self.assertIsNone(steps["t_star"])
        self.assertEqual(steps["d_min"], 3.5)
        self.assertEqual(steps["computed_decision"], "No alert")

    def test_scenario_4_crossing_late(self):
        res = self.runner.run_scenario("S4")
        steps = res["analytical_steps"]
        self.assertEqual(steps["t_star"], 8.77)  # rounds to 8.8 s in paper
        self.assertEqual(steps["d_min"], 74.88)  # rounds to 74.9 m in paper
        self.assertEqual(steps["computed_decision"], "No alert")

    def test_scenario_5_moving_apart(self):
        res = self.runner.run_scenario("S5")
        steps = res["analytical_steps"]
        self.assertEqual(steps["t_star"], -4.0)
        self.assertEqual(steps["d_min"], 40.0)
        self.assertEqual(steps["computed_decision"], "No alert")

    def test_500m_radius_filter(self):
        from backend.grid_index import SpatialGridIndex
        from backend.models import VehicleState, VehicleRole

        grid = SpatialGridIndex(cell_size=300.0, v_min=2.0)
        host = VehicleState(
            vehicle_id="car_host", label="Host", role=VehicleRole.STANDARD,
            latitude=11.0, longitude=77.0, accuracy=3.0, pos_x=0.0, pos_y=0.0,
            speed_smoothed=10.0, heading_deg=0.0, timestamp=0, last_update_monotonic=0
        )
        near_car = VehicleState(
            vehicle_id="car_near", label="Near (200m)", role=VehicleRole.STANDARD,
            latitude=11.0018, longitude=77.0, accuracy=3.0, pos_x=0.0, pos_y=200.0,
            speed_smoothed=10.0, heading_deg=0.0, timestamp=0, last_update_monotonic=0
        )
        far_car = VehicleState(
            vehicle_id="car_far", label="Far (700m)", role=VehicleRole.STANDARD,
            latitude=11.0063, longitude=77.0, accuracy=3.0, pos_x=0.0, pos_y=700.0,
            speed_smoothed=10.0, heading_deg=0.0, timestamp=0, last_update_monotonic=0
        )

        vehicles = {"car_host": host, "car_near": near_car, "car_far": far_car}
        grid.update_vehicle(host)
        grid.update_vehicle(near_car)
        grid.update_vehicle(far_car)

        # Candidate pairs filtered by 500m radius from host
        pairs = grid.get_candidate_pairs(vehicles, host_vehicle=host, max_radius_from_host=500.0)
        pair_ids = [{p[0].vehicle_id, p[1].vehicle_id} for p in pairs]

        # Near car must be included
        self.assertTrue({"car_host", "car_near"} in pair_ids)
        # Far car (>500m) must be strictly excluded
        self.assertFalse(any("car_far" in s for s in pair_ids))
        self.assertFalse(far_car.in_analysis_zone)
        self.assertTrue(near_car.in_analysis_zone)

if __name__ == "__main__":
    unittest.main()

