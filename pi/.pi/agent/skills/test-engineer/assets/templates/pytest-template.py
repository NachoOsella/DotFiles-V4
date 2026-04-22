# Arr-Act-Assert (AAA) pattern template for Pytest
# File: tests/test_${FILENAME}.py

"""
Brief description of what this test module covers.
"""

import pytest
from unittest.mock import Mock, patch

# Arrange: Common setup for all tests in this module
@pytest.fixture
def ${instance_or_mock}():
    return ${ClassOrFunctionName}()

# Happy path test
def test_should_${expected_behavior}_when_${condition}(${instance_or_mock}):
    # Arrange: Set up preconditions and inputs
    ${input_var} = ${input_value}

    # Act: Execute the function/method under test
    ${result_var} = ${instance_or_mock}.${method_name}(${input_var})

    # Assert: Verify expected outcomes
    assert ${result_var} == ${expected_result}
    # Alternative assertions:
    # assert ${result_var} > ${value}
    # assert ${result_var} == pytest.approx(${float_value})
    # with pytest.raises(${ErrorType}):
    #     ${instance_or_mock}.${method_name}(${bad_input})

# Edge case test
def test_should_handle_${edge_case}_correctly(${instance_or_mock}):
    # Arrange
    ${input_var} = ${edge_case_value}

    # Act
    ${result_var} = ${instance_or_mock}.${method_name}(${input_var})

    # Assert
    assert ${result_var} == ${expected_edge_result}

# Error condition test
def test_should_throw_${error_type}_when_${error_condition}(${instance_or_mock}):
    # Arrange
    ${input_var} = ${invalid_input}

    # Act & Assert
    with pytest.raises(${ErrorType}):
        ${instance_or_mock}.${method_name}(${input_var})