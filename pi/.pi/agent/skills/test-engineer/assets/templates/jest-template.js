// Arr-Act-Assert (AAA) pattern template for Jest
// File: __tests__/${FILENAME}.test.js or ${FILENAME}.spec.js

/**
 * @description Brief description of what this test suite covers
 */
describe('${CLASS_OR_FUNCTION_NAME}', () => {
  // Arrange: Common setup for all tests in this suite
  let ${INSTANCE_OR_MOCK};

  beforeEach(() => {
    // Initialize fresh instance or mocks for each test
    ${INSTANCE_OR_MOCK} = new ${CLASS_OR_FUNCTION_NAME}();
    // Mock dependencies if needed
    // ${DEPENDENCY_MOCK} = jest.fn();
  });

  // Happy path test
  test('should ${EXPECTED_BEHAVIOR} when ${CONDITION}', () => {
    // Arrange: Set up preconditions and inputs
    const ${INPUT_VAR} = ${INPUT_VALUE};

    // Act: Execute the function/method under test
    const ${RESULT_VAR} = ${INSTANCE_OR_MOCK}.${METHOD_NAME}(${INPUT_VAR});

    // Assert: Verify expected outcomes
    expect(${RESULT_VAR}).toBe(${EXPECTED_RESULT});
    // Alternative assertions:
    // expect(${RESULT_VAR}).toEqual(${EXPECTED_OBJECT});
    // expect(${RESULT_VAR}).toBeGreaterThan(${VALUE});
    // expect(() => ${INSTANCE_OR_MOCK}.${METHOD_NAME}(${BAD_INPUT})).toThrow(${ERROR_TYPE});
  });

  // Edge case test
  test('should handle ${EDGE_CASE} correctly', () => {
    // Arrange
    const ${INPUT_VAR} = ${EDGE_CASE_VALUE};

    // Act
    const ${RESULT_VAR} = ${INSTANCE_OR_MOCK}.${METHOD_NAME}(${INPUT_VAR});

    // Assert
    expect(${RESULT_VAR}).toBe(${EXPECTED_EDGE_RESULT});
  });

  // Error condition test
  test('should throw ${ERROR_TYPE} when ${ERROR_CONDITION}', () => {
    // Arrange
    const ${INPUT_VAR} = ${INVALID_INPUT};

    // Act & Assert
    expect(() => ${INSTANCE_OR_MOCK}.${METHOD_NAME}(${INPUT_VAR})).toThrow(${ERROR_TYPE});
  });
});