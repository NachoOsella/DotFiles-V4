// Arr-Act-Assert (AAA) pattern template for Go testing
// File: ${FILENAME}_test.go

package ${PACKAGE_NAME}

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

// TestSuite for ${TYPE_NAME} describes the test suite.
func Test${TYPE_NAME}(t *testing.T) {
	// Arrange: Common setup for all tests in this suite
	var ${instanceName} ${TYPE_NAME}
	// Initialize instance or mocks
	${instanceName} = &${TYPE_NAME}{}
	// If using mocks:
	// mockCtrl := gomock.NewController(t)
	// defer mockCtrl.Finish()
	// mockDependency := NewMockDependency(mockCtrl)
	// ${instanceName} = New${TYPE_NAME}(mockDependency)

	// Happy path test
	t.Run("should${ExpectedBehavior}When${Condition}", func(t *testing.T) {
		// Arrange: Set up preconditions and inputs
		${inputVar} := ${inputValue}

		// Act: Execute the function/method under test
		${resultVar}, ${errVar} := ${instanceName}.${MethodName}(${inputVar})

		// Assert: Verify expected outcomes
		assert.NoError(t, ${errVar})
		assert.Equal(t, ${expectedResult}, ${resultVar})
		// Alternative assertions:
		// assert.Greater(t, ${resultVar}, ${value})
		// assert.Len(t, ${sliceResult}, ${length})
		// assert.ErrorIs(t, ${errVar}, ${expectedError})
	})

	// Edge case test
	t.Run("shouldHandle${EdgeCase}Correctly", func(t *testing.T) {
		// Arrange
		${inputVar} := ${edgeCaseValue}

		// Act
		${resultVar}, ${errVar} := ${instanceName}.${MethodName}(${inputVar})

		// Assert
		assert.NoError(t, ${errVar})
		assert.Equal(t, ${expectedEdgeResult}, ${resultVar})
	})

	// Error condition test
	t.Run("shouldThrow${ErrorType}When${ErrorCondition}", func(t *testing.T) {
		// Arrange
		${inputVar} := ${invalidInput}

		// Act
		${resultVar}, ${errVar} := ${instanceName}.${MethodName}(${inputVar})

		// Assert
		assert.ErrorIs(t, ${errVar}, ${expectedErrorType})
		// Alternatively, if the function returns an error and no value:
		// assert.Error(t, ${errVar})
		// assert.Nil(t, ${resultVar})
	})
}