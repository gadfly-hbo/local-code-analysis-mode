def test_worker_package_exposes_version():
    import worker

    assert worker.__version__ == "0.1.0"
