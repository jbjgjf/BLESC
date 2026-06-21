from sentra.backend.app.analytics.graph_index import traverse_graph
print("Test 1")
edges = [{"source_node_id": 1, "target_node_id": 2}]
print(traverse_graph([1], edges))
