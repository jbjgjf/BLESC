from sentra.backend.app.analytics.graph_index import traverse_graph
print("Test 2")
edges = [{"source_node_id": 1, "target_node_id": i} for i in range(2, 40)]
print(len(traverse_graph([1], edges, max_nodes=30)))
